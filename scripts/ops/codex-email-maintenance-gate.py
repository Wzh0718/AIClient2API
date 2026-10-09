"""Reversible Nginx 503 gate for the one-time Codex email archive repair."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


MARKER = "# yyn-codex-email-archive-maintenance"
RULE = 'if ($uri !~ "^/(api/health|runtime/health)$") { return 503; }'

def parse_targets(values):
    targets = {}
    for value in values:
        filename, separator, count = value.rpartition("=")
        if not separator or not filename or not count.isdigit() or int(count) < 1:
            raise ValueError("target must be an absolute Nginx path=positive-server-count")
        target = Path(filename)
        if not target.is_absolute():
            raise ValueError("Nginx target must be absolute")
        target = target.resolve()
        if target in targets:
            raise ValueError("duplicate Nginx target")
        targets[target] = int(count)
    if not targets:
        raise ValueError("at least one Nginx target is required")
    return targets


def digest(data):
    return hashlib.sha256(data).hexdigest()


def gated_text(original, expected_servers):
    if MARKER in original:
        raise ValueError("maintenance marker already exists")
    pattern = re.compile(r"^(\s*)server_name\s+[^;]+;\s*$", re.M)
    if len(pattern.findall(original)) != expected_servers:
        raise ValueError("unexpected Nginx server count")
    return pattern.sub(lambda match: match.group(0) + "\n" + match.group(1)
                       + MARKER + "\n" + match.group(1) + RULE, original)


def atomic_replace(target, data):
    temporary = target.with_name(target.name + ".codex-email.tmp")
    if temporary.exists():
        raise ValueError(f"staging file already exists: {temporary}")
    stat = target.stat()
    with temporary.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, stat.st_mode)
    os.chown(temporary, stat.st_uid, stat.st_gid)
    os.replace(temporary, target)


def reload_nginx():
    subprocess.run(["nginx", "-t"], check=True, capture_output=True, text=True)
    subprocess.run(["nginx", "-s", "reload"], check=True, capture_output=True, text=True)


def arm(state_dir, apply, targets):
    if state_dir.exists():
        raise ValueError("maintenance state directory already exists")
    originals = {}
    gated = {}
    for target, expected_servers in targets.items():
        original = target.read_bytes()
        originals[target] = original
        gated[target] = gated_text(original.decode("utf-8"), expected_servers).encode("utf-8")
    report = {"phase": "arm", "apply": apply, "files": [
        {"path": str(target), "originalSha256": digest(originals[target]),
         "gatedSha256": digest(gated[target])} for target in targets
    ]}
    if not apply:
        return report
    state_dir.mkdir(mode=0o700, parents=True)
    for index, target in enumerate(targets):
        backup = state_dir / f"nginx-original-{index}.conf"
        backup.write_bytes(originals[target])
        os.chmod(backup, 0o600)
    manifest = state_dir / "manifest.json"
    manifest.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    os.chmod(manifest, 0o600)
    changed = []
    try:
        for target in targets:
            if digest(target.read_bytes()) != digest(originals[target]):
                raise ValueError(f"Nginx file changed during arm: {target}")
            atomic_replace(target, gated[target])
            changed.append(target)
        reload_nginx()
    except BaseException:
        for target in reversed(changed):
            if digest(target.read_bytes()) == digest(gated[target]):
                atomic_replace(target, originals[target])
        reload_nginx()
        raise
    return report


def disarm(state_dir, apply, targets):
    manifest = json.loads((state_dir / "manifest.json").read_text(encoding="utf-8"))
    recorded_targets = [Path(item["path"]) for item in manifest["files"]]
    if len(recorded_targets) != len(set(recorded_targets)) or set(recorded_targets) != set(targets):
        raise ValueError("Nginx manifest targets do not match explicit targets")
    original_data = {}
    for index, item in enumerate(manifest["files"]):
        target = Path(item["path"])
        if target not in targets:
            raise ValueError(f"unrecognized Nginx target: {target}")
        original = (state_dir / f"nginx-original-{index}.conf").read_bytes()
        if digest(original) != item["originalSha256"]:
            raise ValueError("Nginx backup checksum mismatch")
        if digest(target.read_bytes()) not in {item["gatedSha256"], item["originalSha256"]}:
            raise ValueError("Nginx gate changed after arm")
        original_data[target] = original
    report = {"phase": "disarm", "apply": apply, "files": [str(target) for target in original_data]}
    if not apply:
        return report
    for target, original in original_data.items():
        if digest(target.read_bytes()) != digest(original):
            atomic_replace(target, original)
    reload_nginx()
    for target, original in original_data.items():
        if digest(target.read_bytes()) != digest(original):
            raise ValueError(f"Nginx restoration mismatch: {target}")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--phase", choices=["arm", "disarm"], required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--target", action="append", required=True,
                        help="absolute Nginx path=expected server count; repeat for each file")
    args = parser.parse_args()
    state_dir = Path(args.state_dir).resolve()
    targets = parse_targets(args.target)
    result = arm(state_dir, args.apply, targets) if args.phase == "arm" else disarm(state_dir, args.apply, targets)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
