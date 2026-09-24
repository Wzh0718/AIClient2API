"""Reversible Nginx ingress gate for the short single-writer handoff."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import time
import urllib.error
import urllib.request

from release import Release, digest, require

MARKER = '# yyn-release-maintenance-gate'
RULE = 'if ($uri !~ "^/(api/health|runtime/health)$") { return 503; }'


def maintenance_text(original):
    require(MARKER not in original, 'maintenance marker already present')
    pattern = re.compile(r'^(\s*)server_name\s+[^;]+;\s*$', re.M)
    matches = list(pattern.finditer(original))
    require(len(matches) == 2, 'expected exactly two Nginx virtual servers')
    return pattern.sub(lambda m: m.group(0) + '\n' + m.group(1) + MARKER + '\n' +
                       m.group(1) + RULE, original)


def public_status(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


class MaintenanceGate:
    def __init__(self, release, status_probe=None):
        self.release = release
        self.status_probe = status_probe or public_status

    def _replace(self, content):
        target = Path(self.release.spec['nginxConfig'])
        temporary = target.with_name(target.name + '.yyn-release.tmp')
        require(not temporary.exists(), 'Nginx staging file already exists')
        original_stat = target.stat()
        with temporary.open('x', encoding='utf-8') as stream:
            stream.write(content)
        shutil.copymode(target, temporary)
        if hasattr(os, 'chown'):
            os.chown(temporary, original_stat.st_uid, original_stat.st_gid)
        os.replace(temporary, target)

    def _reload(self):
        self.release.runner(['nginx', '-t'])
        self.release.runner(['nginx', '-s', 'reload'])

    def _wait_status(self, expected_maintenance):
        url = self.release.spec['publicUrl'] + '/v1/models'
        for attempt in range(10):
            status = self.status_probe(url)
            if (status == 503) == expected_maintenance:
                return status
            if attempt < 9:
                time.sleep(0.25)
        raise ValueError('public API did not enter maintenance mode' if expected_maintenance
                         else 'public API still returns 503 after ingress restoration')

    def arm(self):
        r = self.release
        require(r.state['phase'] == 'prepared', 'maintenance gate requires prepared release')
        require(r.inspect(r.spec['activeContainer'])['Id'] == r.state['oldId'], 'active container changed')
        require(r.state.get('maintenanceActive') is not True, 'maintenance gate already active')
        target = Path(r.spec['nginxConfig'])
        require(digest(target) == r.state['nginxHash'], 'Nginx config changed')
        original = target.read_text(encoding='utf-8')
        gated = maintenance_text(original)
        evidence = r.directory / 'nginx-gated.private.conf'
        expected_hash = hashlib.sha256(gated.replace('\n', os.linesep).encode('utf-8')).hexdigest()
        if evidence.exists():
            require(evidence.is_file() and not evidence.is_symlink() and digest(evidence) == expected_hash,
                    'gated Nginx evidence differs from the current site')
        else:
            evidence.write_text(gated, encoding='utf-8')
            os.chmod(evidence, 0o600)
        gated_hash = digest(evidence)
        try:
            self._replace(gated)
            self._reload()
            self._wait_status(True)
        except BaseException:
            if digest(target) == gated_hash:
                self._replace(original)
                self._reload()
            raise
        r.save(maintenanceActive=True, maintenanceHash=gated_hash)
        return {'maintenance': 'active', 'publicApiStatus': 503}

    def disarm(self):
        r = self.release
        target = Path(r.spec['nginxConfig'])
        if not r.state.get('maintenanceActive'):
            require(digest(target) == r.state['nginxHash'], 'untracked Nginx maintenance state')
            return {'maintenance': 'inactive'}
        require(digest(target) == r.state['maintenanceHash'], 'Nginx maintenance file changed')
        original = r.directory / 'nginx-before.private.conf'
        require(digest(original) == r.state['nginxHash'], 'Nginx recovery copy changed')
        self._replace(original.read_text(encoding='utf-8'))
        self._reload()
        require(digest(target) == r.state['nginxHash'], 'Nginx restoration mismatch')
        r.save(maintenanceActive=False)
        self._wait_status(False)
        return {'maintenance': 'inactive'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--phase', choices=['arm', 'disarm'], required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    r = Release(args.spec, args.state_dir)
    r.identity()
    gate = MaintenanceGate(r)
    if not args.apply:
        print({'dryRun': True, 'phase': args.phase, 'state': r.state.get('phase', 'none')})
        return
    print(getattr(gate, args.phase)())


if __name__ == '__main__':
    main()
