# Shared by up.sh and check.sh; moto_dir is set by the caller.
repo_root=$(CDPATH= cd -- "$moto_dir/../.." && pwd)
env_file="$moto_dir/.env.example"
if [ -f "$moto_dir/.env" ]; then
  env_file="$moto_dir/.env"
fi

compose() {
  docker compose --project-directory "$repo_root" \
    --env-file "$env_file" -f "$repo_root/compose.yaml" "$@"
}
