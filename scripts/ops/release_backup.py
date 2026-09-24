"""Allowlisted release snapshots. No database reads, discovery or restore side effects."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tarfile

EXCLUDED_DIRS = {'request-audit', 'app-logs', 'logs', 'usage-events', 'permanent-usage-ledger',
                 'runtime-hook-spool', 'backups', 'backup', 'tmp', 'candidate-configs'}
DB = re.compile(r'\.(sqlite\d*|db)([.-]|$)|\.(wal|shm)$', re.I)
REQUIRED_IF_PRESENT = {'config.json', 'provider_pools.json', 'api-potluck-keys.json',
                       'api-potluck-data.json', 'custom_models.json', 'plugins.json', 'pwd',
                       'input_system_prompt.txt', 'fetch_system_prompt.txt'}


def validate_references(config_dir, files):
    """Fail on omitted known config files or referenced credential/prompt paths."""
    root = Path(config_dir).resolve()
    selected = {Path(name).as_posix() for name in files}
    for name in REQUIRED_IF_PRESENT:
        if (root / name).is_file() and name not in selected:
            raise ValueError('required configuration file missing from release manifest: ' + name)
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key.endswith('_FILE_PATH') and isinstance(item, str) and item:
                    relative = item.replace('\\', '/')
                    if relative.startswith('/app/configs/'):
                        relative = relative[len('/app/configs/'):]
                    else:
                        relative = relative.removeprefix('./').removeprefix('configs/')
                    if relative not in selected:
                        raise ValueError('referenced file missing from release manifest; inspect private configuration')
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    for name in ('config.json', 'provider_pools.json'):
        if (root / name).is_file():
            visit(json.loads((root / name).read_text(encoding='utf-8-sig')))


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def inventory(config_dir, files):
    root = Path(config_dir).resolve(strict=True)
    if not isinstance(files, list) or not files:
        raise ValueError('release files must be a nonempty explicit list of relative files')
    result = []
    for name in sorted(set(files)):
        rel = Path(name)
        if rel.is_absolute() or '..' in rel.parts or not rel.parts:
            raise ValueError('unsafe release file path')
        if any(p.lower() in EXCLUDED_DIRS or p.lower().endswith('-spool') for p in rel.parts) or DB.search(name):
            raise ValueError('database/history/spool path cannot be in a normal release snapshot')
        source = root / rel
        if any(p.is_symlink() for p in [source, *source.parents] if p != root):
            raise ValueError('symlinks are not allowed in release files')
        source.resolve(strict=True).relative_to(root)
        if not source.is_file():
            raise ValueError('release allowlist accepts files only; enumerate referenced credentials explicitly')
        result.append({'path': rel.as_posix(), 'bytes': source.stat().st_size})
    return result


def estimate(config_dir, files, warning_bytes=500 * 1024 * 1024):
    entries = inventory(config_dir, files)
    validate_references(config_dir, files)
    total = sum(e['bytes'] for e in entries)
    # Paths can contain account identifiers; only aggregate sizes go to stdout.
    return {'fileCount': len(entries), 'bytes': total, 'warningBytes': warning_bytes,
            'overBudget': total > warning_bytes, 'largestFileBytes': sorted((e['bytes'] for e in entries), reverse=True)[:10]}


def snapshot(config_dir, files, destination):
    entries = inventory(config_dir, files)
    validate_references(config_dir, files)
    destination = Path(destination)
    root = Path(config_dir).resolve()
    if destination.resolve() == root or root in destination.resolve().parents:
        raise ValueError('snapshot must be outside the configuration volume')
    if destination.exists():
        raise ValueError('snapshot already exists; refusing to overwrite recovery evidence')
    required = sum(e['bytes'] for e in entries)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(destination.parent).free < required + 512 * 1024 * 1024:
        raise ValueError('insufficient disk space for release snapshot')
    destination.mkdir(mode=0o700)
    for entry in entries:
        target = destination / 'configs' / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(root / entry['path'], target)
        os.chmod(target, 0o600)
        entry['sha256'] = digest(target)
    write_json(destination / 'snapshot.json', {'kind': 'aiclient-release-snapshot-v1', 'files': entries})
    return estimate(config_dir, files)


def finalize(destination):
    destination = Path(destination)
    manifest = json.loads((destination / 'snapshot.json').read_text(encoding='utf-8'))
    if manifest.get('kind') != 'aiclient-release-snapshot-v1':
        raise ValueError('unowned snapshot')
    inventory(destination / 'configs', [entry['path'] for entry in manifest['files']])
    for entry in manifest['files']:
        if digest(destination / 'configs' / entry['path']) != entry['sha256']:
            raise ValueError('snapshot content changed; cannot finalize')
    archive = destination / 'configs.tar.gz'
    partial = destination / 'configs.tar.gz.partial'
    # Fast compression happens only after service recovery. tarfile writes gzip
    # directly and never invokes a shell or archives unrelated directory contents.
    with tarfile.open(partial, 'w:gz', compresslevel=1) as output:
        for entry in manifest['files']:
            output.add(destination / 'configs' / entry['path'], arcname='configs/' + entry['path'], recursive=False)
    with tarfile.open(partial, 'r:gz') as check:
        members = check.getmembers()
        if len(members) != len(manifest['files']):
            raise ValueError('archive member count mismatch')
        for entry, member in zip(manifest['files'], members):
            if member.name != 'configs/' + entry['path'] or not member.isfile():
                raise ValueError('archive member mismatch')
            h = hashlib.sha256()
            with check.extractfile(member) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(block)
            if h.hexdigest() != entry['sha256']:
                raise ValueError('archive checksum mismatch')
    # Also force gzip CRC/trailer validation to EOF.
    import gzip
    with gzip.open(partial, 'rb') as stream:
        while stream.read(1024 * 1024):
            pass
    os.chmod(partial, 0o600)
    os.replace(partial, archive)
    result = {'sha256': digest(archive), 'bytes': archive.stat().st_size}
    write_json(destination / 'archive-verified.json', result)
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--action', choices=['plan', 'snapshot', 'finalize'], default='plan')
    p.add_argument('--config-dir')
    p.add_argument('--manifest', help='JSON array of relative required config/credential files')
    p.add_argument('--destination', required=True)
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()
    if args.action == 'finalize':
        result = finalize(args.destination) if args.apply else {'dryRun': 'finalize'}
    else:
        files = json.loads(Path(args.manifest).read_text(encoding='utf-8'))
        result = estimate(args.config_dir, files)
        if args.action == 'snapshot' and args.apply:
            result = snapshot(args.config_dir, files, args.destination)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
