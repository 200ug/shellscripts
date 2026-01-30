#!/usr/bin/env bash

# exit immediately if any cmd fails, we refer unset variable, or any pipeline cmd fails
set -euo pipefail

CONFIG="$HOME/.config/gs.conf"
SSH_OPTS="-o PasswordAuthentication=no -o BatchMode=yes" # never prompt for password

usage() {
    cat <<EOF
[?] usage: $0 <cmd> [args]

[?] commands:
    init <user@host:port:remote_dir>    init config with remote settings
    push                                push local files to remote
    pull                                pull remote files to local
    status                              show what would be transferred

EOF
    exit 1
}

die() {
    echo "[!] error: $1" >&2
    exit 1
}

validate_remote() {
    # format: user@host:port:remote_dir
    local remote="$1"
    if [[ ! "$remote" =~ ^[^@]+@[^:]+:[0-9]+:.+$ ]]; then
        die "invalid remote format, expected user@host:port:remote_dir"
    fi
}

cmd_init() {
    [[ "$#" -eq 1 ]] || die "usage: $0 init <user@host:port:remote_dir>"

    local remote="$1"
    validate_remote "$1"

    mkdir -p $(dirname "$CONFIG")
    cat > "$CONFIG" <<EOF
$remote
# exclude patterns (one per line)
.DS_Store
*.tmp
*.swp
.git
node_modules
EOF
    echo "[+] initialized $CONFIG"
}

parse_config() {
    [[ -f "$CONFIG" ]] || die "not initialized, run: $0 init <remote>"

    local first_line
    first_line=$(head -n1 "$CONFIG")
    user_host="${first_line%%:*}"
    local rest="${first_line#*:}"
    port="${rest%%:*}"
    remote_dir="${rest#*:}"

    # build exclude args from remaining lines (skip comments and blanks)
    exclude_args=()
    while IFS= read -r line; do
        [[ -z "$line" || "$line" =~ ^# ]] && continue
        exclude_args+=(--exclude "$line")
    done < <(tail -n +2 "$CONFIG")
}

get_local_basedir() {
    basename "$(pwd)"
}

cmd_push() {
    parse_config
    local local_name
    local_name=$(get_local_basedir)

    rsync -avz --delete "${exclude_args[@]}" -e "ssh -p $port $SSH_OPTS" ./ "$user_host:$remote_dir/$local_name/"
}

cmd_pull() {
    parse_config
    local local_name
    local_name=$(get_local_basedir)

    rsync -avz --delete "${exclude_args[@]}" -e "ssh -p $port $SSH_OPTS" "$user_host:$remote_dir/$local_name/" ./ 
}

cmd_status() {
    parse_config
    local local_name
    local_name=$(get_local_basedir)

    echo "--- push: local -> remote ---"
    rsync -avzn --delete "${exclude_args[@]}" --itemize-changes -e "ssh -p $port $SSH_OPTS" ./ "$user_host:$remote_dir/$local_name/" 2>/dev/null || true
    echo ""
    echo "--- pull: local <- remote ---"
    rsync -avzn --delete "${exclude_args[@]}" --itemize-changes -e "ssh -p $port $SSH_OPTS" "$user_host:$remote_dir/$local_name/" ./ 2>/dev/null || true
}

[[ "$#" -ge 1 ]] || usage

case "$1" in
    init)   shift; cmd_init "$@" ;;
    push)   cmd_push ;;
    pull)   cmd_pull ;;
    status) cmd_status ;;
    *)      usage ;;
esac

