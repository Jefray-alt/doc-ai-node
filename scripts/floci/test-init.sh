#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
mkdir "$temp_dir/bin"
cat >"$temp_dir/bin/aws" <<'AWS'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$AWS_LOG"
if [ "$1 $2" = 's3api list-buckets' ]; then
  printf '%s\n' "${AWS_EXISTING_BUCKETS:-0}"
fi
AWS
chmod +x "$temp_dir/bin/aws"
export AWS_LOG="$temp_dir/aws.log"
export S3_BUCKET_NAME=doc-ai-local-pdfs
export S3_QUARANTINE_BUCKET_NAME=doc-ai-local-quarantine
export PATH="$temp_dir/bin:$PATH"

sh "$repo_root/infra/floci/init/01-create-dev-bucket.sh"

grep -F 'create-bucket --bucket doc-ai-local-pdfs' "$AWS_LOG" >/dev/null
grep -F 'create-bucket --bucket doc-ai-local-quarantine' "$AWS_LOG" >/dev/null
grep -F 'put-bucket-cors --bucket doc-ai-local-quarantine' "$AWS_LOG" >/dev/null
grep -F 'AllowedMethods":["POST"]' "$AWS_LOG" >/dev/null
grep -F 'AllowedOrigins":["http://localhost:5173","http://127.0.0.1:5173"]' "$AWS_LOG" >/dev/null

export AWS_EXISTING_BUCKETS=1
sh "$repo_root/infra/floci/init/01-create-dev-bucket.sh"
create_count=$(grep -c 'create-bucket --bucket' "$AWS_LOG")
test "$create_count" -eq 2

echo 'Floci initialization test passed'
