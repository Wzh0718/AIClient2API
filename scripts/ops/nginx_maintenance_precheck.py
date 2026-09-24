"""Validate the temporary maintenance site in a shadow Nginx config."""
import argparse
from pathlib import Path
import hashlib

from release import digest, require
from release_maintenance import maintenance_text


def precheck(release, main_path=None):
    site = Path(release.spec['nginxConfig']).resolve(strict=True)
    main = Path(main_path or release.spec.get('nginxMainConfig', '/etc/nginx/nginx.conf')).resolve(strict=True)
    conf_dir = site.parent
    source_hash = hashlib.sha256((digest(main) + digest(site)).encode('ascii')).hexdigest()
    if release.state.get('nginxPreviewPassedHash') == source_hash:
        return {'nginxMaintenanceSyntax': 'passed', 'guardedServers': 2, 'reused': True}
    source = main.read_text(encoding='utf-8')
    include = 'include ' + str(conf_dir / '*.conf') + ';'
    require(source.count(include) == 1, 'Nginx main config has an unexpected site include')
    preview_site = release.directory / 'nginx-maintenance-preview.conf'
    preview_main = release.directory / 'nginx-main-preview.conf'
    require(not preview_site.exists() and not preview_main.exists(), 'Nginx preview already exists')
    preview_site.write_text(maintenance_text(site.read_text(encoding='utf-8')), encoding='utf-8')
    imports = [*sorted(conf_dir.glob('*.conf'))]
    require(site in imports, 'active site is not in the expected Nginx include directory')
    replacement = '\n'.join('include ' + str(p) + ';' for p in imports if p != site)
    replacement += '\ninclude ' + str(preview_site) + ';'
    preview_main.write_text(source.replace(include, replacement), encoding='utf-8')
    release.runner(['nginx', '-t', '-c', str(preview_main)])
    release.save(nginxPreviewPassedHash=source_hash)
    return {'nginxMaintenanceSyntax': 'passed', 'guardedServers': 2}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--state-dir', required=True)
    args = parser.parse_args()
    from release import Release
    release = Release(args.spec, args.state_dir)
    release.identity()
    require(release.state.get('phase') == 'prepared', 'prepared state required')
    print(precheck(release))


if __name__ == '__main__':
    main()
