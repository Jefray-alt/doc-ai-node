#!/usr/bin/env python3
"""Serial task transaction guard. Run from the project Git root; Python 3.11+."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid


class GuardError(Exception):
    pass


def run(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True)
    if result.returncode:
        raise GuardError(result.stderr.decode(errors='replace').strip())
    return result.stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def path_at(root, name):
    rel = Path(name)
    if rel.is_absolute() or not rel.parts or any(p in ('.git', '..') for p in rel.parts):
        raise GuardError(f'Expected a repository-relative file: {name}')
    path = root / rel
    for part in [path, *path.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise GuardError(f'Symlinks are unsupported: {name}')
    if path.exists() and not path.is_file():
        raise GuardError(f'Expected an explicit regular file: {name}')
    return path


def repo():
    cwd = Path.cwd().resolve()
    root = Path(os.fsdecode(run(cwd, 'rev-parse', '--show-toplevel')).strip()).resolve()
    if cwd != root:
        raise GuardError('Run from the Git root')
    common = Path(os.fsdecode(run(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).strip())
    return root, common / 'openspec-tdd'


def clean(root):
    if run(root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'):
        raise GuardError('Dirty working tree/index, including untracked files; preserve user work and stop')


def baseline(root, state):
    if run(root, 'rev-parse', 'HEAD').decode().strip() != state['base']:
        raise GuardError('HEAD moved during the task; stop for recovery')
    for name in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_START'):
        loc = Path(os.fsdecode(run(root, 'rev-parse', '--git-path', name)).strip())
        if not loc.is_absolute():
            loc = root / loc
        if loc.exists():
            raise GuardError(f'Git operation in progress: {name}')
    flags = run(root, 'ls-files', '-v', '-z').split(b'\0')
    if any(item and (item[:1].islower() or item[:1] == b'S') for item in flags):
        raise GuardError('Skip-worktree/assume-unchanged entries are unsupported')
    if any(item.startswith(b'160000 ') for item in run(root, 'ls-files', '--stage', '-z').split(b'\0')):
        raise GuardError('Submodule repositories are unsupported by this guard')
    if run(root, 'diff', '--cached', '--name-only', '-z'):
        raise GuardError('Index changed outside the orchestrator; preserve it and stop')


def changed(root):
    names = run(root, 'diff', '--name-only', '--no-renames', '-z', 'HEAD').split(b'\0')
    names += run(root, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0')
    return sorted({os.fsdecode(n) for n in names if n})


def candidate(root, state):
    baseline(root, state)
    original = base64.b64decode(state['task_original'])
    if path_at(root, state['task_file']).read_bytes() != original:
        raise GuardError('Task tracking file changed before commit; restore only your own edits')
    names = changed(root)
    unexpected = set(names) - set(state['allow'])
    if unexpected:
        raise GuardError(f'Out-of-scope changes: {sorted(unexpected)}')
    records = []
    for name in names:
        path = path_at(root, name)
        records.append([name, sha(path.read_bytes()) if path.exists() else None,
                        bool(path.stat().st_mode & 0o111) if path.exists() else False])
    data = json.dumps([state['base'], state['task_file'], state['line'], state['task_original'], records],
                      ensure_ascii=True, sort_keys=True).encode()
    return sha(data), names


def save(directory, state):
    tmp = directory / 'active.tmp'
    tmp.write_text(json.dumps(state, indent=2) + '\n')
    os.replace(tmp, directory / 'active.json')


def load(directory, root):
    path = directory / 'active.json'
    if not path.exists():
        raise GuardError('No active task; begin first')
    state = json.loads(path.read_text())
    if state['root'] != str(root):
        raise GuardError('Another worktree owns the active task')
    return state


def begin(root, directory, args):
    clean(root)
    state = dict(root=str(root), base=run(root, 'rev-parse', 'HEAD').decode().strip())
    baseline(root, state)
    task_path = path_at(root, args.task_file)
    original = task_path.read_bytes()
    run(root, 'ls-files', '--error-unmatch', '--', args.task_file)
    lines = original.splitlines(keepends=True)
    if not 1 <= args.line <= len(lines) or not re.match(rb'^\s*- \[ \] .+', lines[args.line - 1]):
        raise GuardError('Selected line must contain the current unchecked task')
    allowed = sorted({str(Path(n)) for n in args.allow})
    tests = sorted({str(Path(n)) for n in args.test})
    if args.task_file in allowed or not set(tests) <= set(allowed):
        raise GuardError('Test files must be allowlisted; task tracking file must not be allowlisted')
    for name in allowed:
        path_at(root, name)
        if subprocess.run(['git', '-C', str(root), 'check-ignore', '--no-index', '-q', '--', name]).returncode == 0:
            raise GuardError(f'Allowlisted file is ignored: {name}')
    state.update(task_file=args.task_file, line=args.line, task_original=base64.b64encode(original).decode(),
                 allow=allowed, tests=tests, events=[], reviews=[], id=uuid.uuid4().hex,
                 max_reviews=args.max_reviews)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        (directory / 'lock').mkdir()
    except FileExistsError:
        raise GuardError('An active/recovery task owns this repository; inspect status, do not bypass the lock')
    try:
        save(directory, state)
    except BaseException:
        (directory / 'lock').rmdir()
        raise
    print(json.dumps({'base': state['base'], 'evidence_dir': str(directory), 'task': state['id']}))


def check(root, directory, state, args):
    if len(state['reviews']) >= state['max_reviews'] or (state['reviews'] and state['reviews'][-1]['verdict'] == 'blocked'):
        raise GuardError('Review limit/block reached; stop, preserve changes and report')
    _, names = candidate(root, state)
    phase = args.phase
    events = state['events']
    successful = [e for e in events if e['accepted']]
    if phase == 'red' and not successful:
        if not names or not set(names) <= set(state['tests']):
            raise GuardError('Initial RED requires test-only changes, before production edits')
    if phase == 'green' and (not successful or successful[-1]['phase'] not in ('red', 'green')):
        raise GuardError('GREEN requires a recorded RED first')
    if phase == 'refactor' and (not successful or successful[-1]['phase'] not in ('green', 'refactor')):
        raise GuardError('REFACTOR requires a recorded GREEN first')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise GuardError('Provide a test command after --')
    if phase == 'green' and successful[-1]['phase'] == 'red' and command != successful[-1]['command']:
        raise GuardError('First GREEN must rerun the exact focused RED command')
    try:
        result = subprocess.run(command, cwd=root, capture_output=True)
        started = True
    except OSError as exc:
        result = subprocess.CompletedProcess(command, 127, b'', str(exc).encode())
        started = False
    digest, _ = candidate(root, state)
    log = directory / f'{state["id"]}-{len(events) + 1}-{phase}.log'
    log.write_bytes(result.stdout + b'\n--- stderr ---\n' + result.stderr)
    accepted = started and (result.returncode == args.red_exit_code if phase == 'red' else result.returncode == 0)
    # Signals, missing executables and unexpected runner statuses are never RED.
    state['events'].append(dict(phase=phase, command=command, exit_code=result.returncode,
                                accepted=accepted, digest=digest, log=str(log)))
    save(directory, state)
    print(json.dumps(state['events'][-1]))
    if not accepted:
        raise GuardError(f'{phase.upper()} did not have its required outcome; inspect {log}')


def snapshot(root, state):
    digest, names = candidate(root, state)
    if not names:
        raise GuardError('No implementation/test changes')
    last = state['events'][-1] if state['events'] else {}
    if last.get('phase') != 'refactor' or not last.get('accepted') or last.get('digest') != digest:
        raise GuardError('Run passing final REFACTOR checks against this exact candidate')
    return dict(digest=digest, files=names, base=state['base'], task_file=state['task_file'],
                line=state['line'], events=state['events'])


def review(root, directory, state, args):
    if len(state['reviews']) >= state['max_reviews'] or (state['reviews'] and state['reviews'][-1]['verdict'] == 'blocked'):
        raise GuardError('Review budget exhausted or blocked; preserve work and stop')
    snap = snapshot(root, state)
    report = json.loads(Path(args.report).read_text())
    if report.get('digest') != snap['digest']:
        raise GuardError('Review is stale or covers another candidate')
    if report.get('verdict') not in ('pass', 'changes_requested', 'blocked'):
        raise GuardError('Invalid review verdict')
    if not report.get('reviewer_id') or not report.get('developer_id') or report['reviewer_id'] == report['developer_id']:
        raise GuardError('Distinct developer and reviewer identities required')
    if not isinstance(report.get('findings'), list) or not isinstance(report.get('evidence'), str) or not report['evidence'].strip():
        raise GuardError('Review needs findings array and evidence summary')
    if report['verdict'] == 'pass' and report['findings']:
        raise GuardError('PASS requires zero unresolved findings')
    state['reviews'].append(report)
    save(directory, state)
    print(json.dumps({'review_round': len(state['reviews']), 'verdict': report['verdict']}))


def finish(directory, state, outcome):
    (directory / f'{state["id"]}-{outcome}.json').write_text(json.dumps(state, indent=2) + '\n')
    (directory / 'active.json').unlink()
    (directory / 'lock').rmdir()


def commit(root, directory, state, args):
    snap = snapshot(root, state)
    last = state['reviews'][-1] if state['reviews'] else {}
    if last.get('verdict') != 'pass' or last.get('digest') != snap['digest']:
        raise GuardError('A current independent PASS is required')
    if not args.message.strip() or args.message.startswith('-'):
        raise GuardError('Provide a descriptive commit message')
    # The only post-review edit permitted is this exact checkbox replacement.
    original = base64.b64decode(state['task_original'])
    lines = original.splitlines(keepends=True)
    lines[state['line'] - 1] = lines[state['line'] - 1].replace(b'- [ ]', b'- [x]', 1)
    path_at(root, state['task_file']).write_bytes(b''.join(lines))
    paths = sorted(set(snap['files']) | {state['task_file']})
    # No broad staging. Literal pathspecs prevent filenames from becoming patterns.
    run(root, '--literal-pathspecs', 'add', '--all', '--', *paths)
    staged = {os.fsdecode(n) for n in run(root, 'diff', '--cached', '--name-only', '--no-renames', '-z').split(b'\0') if n}
    if staged != set(paths):
        raise GuardError('Staged file set differs from the reviewed task; preserve index and stop')
    run(root, 'diff', '--cached', '--check')
    tree = run(root, 'write-tree').decode().strip()
    run(root, 'commit', '-m', args.message)
    head = run(root, 'rev-parse', 'HEAD').decode().strip()
    if run(root, 'rev-parse', 'HEAD^').decode().strip() != state['base'] or run(root, 'rev-parse', 'HEAD^{tree}').decode().strip() != tree:
        raise GuardError('Commit/hook changed the expected parent or tree; do not amend/reset automatically')
    clean(root)
    state['commit'] = head
    finish(directory, state, 'committed')
    print(json.dumps({'commit': head, 'files': paths}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('begin')
    p.add_argument('--task-file', required=True)
    p.add_argument('--line', required=True, type=int)
    p.add_argument('--allow', required=True, action='append', help='Exact relative file; repeat as needed')
    p.add_argument('--test', required=True, action='append', help='Test file subset of --allow')
    p.add_argument('--max-reviews', type=int, choices=range(1, 4), default=3)
    p = sub.add_parser('check')
    p.add_argument('--phase', choices=['red', 'green', 'refactor'], required=True)
    p.add_argument('--red-exit-code', type=int, choices=range(1, 126), default=1,
                   help='Expected assertion-failure exit status for RED (default: 1)')
    p.add_argument('command', nargs=argparse.REMAINDER)
    sub.add_parser('snapshot')
    p = sub.add_parser('review')
    p.add_argument('--report', required=True)
    p = sub.add_parser('commit')
    p.add_argument('--message', required=True)
    sub.add_parser('status')
    sub.add_parser('abort', help='Release task lock, preserving all work and index; stop agents first')
    args = parser.parse_args()
    try:
        root, directory = repo()
        if args.action == 'begin':
            begin(root, directory, args)
        elif args.action == 'status':
            print((directory / 'active.json').read_text() if (directory / 'active.json').exists() else 'No active task')
        else:
            state = load(directory, root)
            if args.action == 'check':
                check(root, directory, state, args)
            elif args.action == 'snapshot':
                print(json.dumps(snapshot(root, state), indent=2))
            elif args.action == 'review':
                review(root, directory, state, args)
            elif args.action == 'commit':
                commit(root, directory, state, args)
            elif args.action == 'abort':
                finish(directory, state, 'aborted')
                print('Lock released; all working files and index preserved. Stop and resolve before restarting.')
    except (GuardError, OSError, ValueError, KeyError) as exc:
        parser.exit(1, f'Guard stopped: {exc}\n')


if __name__ == '__main__':
    main()
