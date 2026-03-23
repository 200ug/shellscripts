#!/usr/bin/env bash

# exit immediately if any cmd fails, we refer unset variable, or any pipeline cmd fails
set -euo pipefail

CONFIG="$HOME/.config/gs.conf"
META=".gs.meta"
SSH_OPTS="-o PasswordAuthentication=no -o BatchMode=yes" # never prompt for password

usage() {
    cat <<EOF
[?] usage: $0 <cmd> [args]

[?] commands:
    init <user@host:port:remote_dir> <gpg_key>   init config with remote and gpg key
    push                                         push local changes to remote (encrypted)
    pull                                         pull remote changes to local (decrypted)
    st                                           show pending changes

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
    [[ "$#" -eq 2 ]] || die "usage: $0 init <user@host:port:remote_dir> <gpg_key>"

    validate_remote "$1"
    mkdir -p "$(dirname "$CONFIG")"
    cat > "$CONFIG" <<EOF
$1
$2
# exclude patterns
.DS_Store
*.tmp
*.swp
.git
node_modules
EOF

    echo "[+] initialized $CONFIG"
}

parse_config() {
    [[ -f "$CONFIG" ]] || die "not initialized, run: $0 init <remote> <gpg_key>"

    local _remote
    { IFS= read -r _remote; IFS= read -r gpg_key; } < "$CONFIG"
    user_host="${_remote%%:*}"
    local _rest="${_remote#*:}"
    port="${_rest%%:*}"
    remote_dir="${_rest#*:}"

    # build exclude patterns from remaining lines (skip comments and blanks)
    exclude_patterns=()
    while IFS= read -r line; do
        [[ -z "$line" || "$line" =~ ^# ]] && continue
        exclude_patterns+=("$line")
    done < <(tail -n +3 "$CONFIG")
}

get_local_basedir() {
    basename "$(pwd)"
}

# list all non-excluded local files as "path<tab>mtime", sorted
list_local_files() {
    local args=(-type f -not -name "$META")

    for p in "${exclude_patterns[@]}"; do
        args+=(-not -name "$p" -not -path "*/$p/*")
    done

    find . "${args[@]}" | sort | while IFS= read -r f; do
        printf "%s\t%s\n" "${f#./}" "$(date -r "$f" +%s)"
    done
}

# return a file's mtime from a meta file, or 0 if absent
lookup_mtime() {
    local path="$1" meta="$2"

    [[ -f "$meta" ]] || { echo 0; return; }
    local v=$(awk -F'\t' -v p="$path" '$1==p{print $2; exit}' "$meta")
    echo "${v:-0}"
}

cmd_push() {
    parse_config

    local local_name=$(get_local_basedir)
    local staging=$(mktemp -d)
    local tmp=$(mktemp)
    list_local_files > "$tmp"

    # encrypt all local files into staging; touch -r preserves mtime so rsync skips unchanged
    while IFS=$'\t' read -r path mtime; do
        echo "[>] $path"
        mkdir -p "$staging/$(dirname "$path")"
        gpg --encrypt --recipient "$gpg_key" --batch --yes --output "$staging/$path.gpg" "$path"
        touch -r "$path" "$staging/$path.gpg"
    done < "$tmp"

    cp "$tmp" "$staging/$META"
    mv "$tmp" "$META"
    rsync -az --delete -e "ssh -p $port $SSH_OPTS" "$staging/" "$user_host:$remote_dir/$local_name/"
    rm -rf "$staging"

    echo "[+] done"
}

cmd_pull() {
    parse_config

    local local_name=$(get_local_basedir)
    local remote_path="$remote_dir/$local_name"
    local tmp=$(mktemp)

    rsync -az -e "ssh -p $port $SSH_OPTS" "$user_host:$remote_path/$META" "$tmp" 2>/dev/null || {
        echo "[i] nothing to pull"
        rm -f "$tmp"
        return
    }

    # download and decrypt changed/new files
    local changed=$(mktemp)
    while IFS=$'\t' read -r path mtime; do
        local old=$(lookup_mtime "$path" "$META")
        [[ "$mtime" -gt "$old" ]] && echo "$path.gpg" >> "$changed"
    done < "$tmp"

    if [[ -s "$changed" ]]; then
        local staging=$(mktemp -d)
        rsync -az --files-from="$changed" -e "ssh -p $port $SSH_OPTS" "$user_host:$remote_path/" "$staging/"

        while IFS=$'\t' read -r path mtime; do
            [[ -f "$staging/$path.gpg" ]] || continue
            echo "[<] $path"
            mkdir -p "$(dirname "$path")"
            gpg --decrypt --batch --yes --output "$path" "$staging/$path.gpg"
            touch -t "$(date -r "$mtime" +%Y%m%d%H%M.%S)" "$path"
        done < "$tmp"

        rm -rf "$staging"
    fi
    rm -f "$changed"

    # remove files deleted remotely
    if [[ -f "$META" ]]; then
        while IFS=$'\t' read -r path _; do
            grep -qF "$(printf '%s\t' "$path")" "$tmp" || {
                echo "[-] $path"
                rm -f "$path"
            }
        done < "$META"
    fi

    mv "$tmp" "$META"

    echo "[+] done"
}

cmd_status() {
    parse_config

    local local_name=$(get_local_basedir)
    local remote_path="$remote_dir/$local_name"
    local tmp=$(mktemp)

    rsync -az -e "ssh -p $port $SSH_OPTS" "$user_host:$remote_path/$META" "$tmp" 2>/dev/null || {
        echo "[i] no remote state"
        rm -f "$tmp"
        return
    }

    local curr=$(mktemp)
    list_local_files > "$curr"
    local change_count=0

    while IFS=$'\t' read -r path mtime; do
        local remote_mtime=$(lookup_mtime "$path" "$tmp")
        [[ "$mtime" -gt "$remote_mtime" ]] && echo "[>>] $path" && ((change_count++))
    done < "$curr"

    while IFS=$'\t' read -r path mtime; do
        local local_mtime=$(lookup_mtime "$path" "$curr")
        [[ "$mtime" -gt "$local_mtime" ]] && echo "[<<] $path" && ((change_count++))
    done < "$tmp"

    echo "[i] total change count: $change_count"

    rm -f "$tmp" "$curr"
}

[[ "$#" -ge 1 ]] || usage

case "$1" in
    init)   shift; cmd_init "$@" ;;
    push)   cmd_push ;;
    pull)   cmd_pull ;;
    st)     cmd_status ;;
    *)      usage ;;
esac
