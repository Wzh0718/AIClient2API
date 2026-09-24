"""Clone a reviewed private release profile for a new pinned commit."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil

from release_backup import write_json


def clone_spec(previous_spec, previous_state, output_root, revision, image, apply=False):
    previous_spec = Path(previous_spec).resolve(strict=True)
    previous_state = Path(previous_state).resolve(strict=True)
    output_root = Path(output_root).resolve()
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('full commit revision required')
    if not re.fullmatch(r'[a-zA-Z0-9_.:/-]+', image):
        raise ValueError('unsafe image reference')
    if output_root.exists() or output_root == previous_state or previous_state in output_root.parents:
        raise ValueError('new release root must not exist or overlap the previous state')
    old = json.loads(previous_spec.read_text(encoding='utf-8'))
    state_name = 'rel-' + output_root.name
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]+', state_name):
        raise ValueError('invalid release name')
    new_state = output_root / 'state' / state_name
    new_private = output_root / 'private'
    old_snapshot = str(previous_state / 'candidate-snapshot' / 'configs')
    new_snapshot = str(new_state / 'candidate-snapshot' / 'configs')
    spec = dict(old, revision=revision, image=image)
    spec.setdefault('nginxMainConfig', '/etc/nginx/nginx.conf')
    copied_files = {}
    transformed = 0
    for key in ('candidateArgs', 'finalArgs'):
        args = list(spec[key])
        for i in range(0, len(args), 2):
            flag, value = args[i:i + 2]
            if flag in ('--volume', '--mount') and old_snapshot in value:
                args[i + 1] = value.replace(old_snapshot, new_snapshot)
                transformed += 1
            elif flag == '--env-file':
                source = Path(value).resolve(strict=True)
                if source not in copied_files:
                    copied_files[source] = new_private / ('runtime-' + str(len(copied_files) + 1) + '.env')
                args[i + 1] = str(copied_files[source])
        spec[key] = args
    if transformed != 1:
        raise ValueError('expected exactly one isolated candidate snapshot mount')
    result = {'revision': revision, 'image': image, 'newStateDir': str(new_state),
              'newSpec': str(new_private / 'spec.json'), 'copiedPrivateEnvFiles': len(copied_files),
              'configFileCount': len(spec['configFiles']), 'apply': apply}
    if not apply:
        return result
    os.umask(0o077)
    output_root.mkdir(mode=0o700)
    new_private.mkdir(mode=0o700)
    (output_root / 'state').mkdir(mode=0o700)
    for source, destination in copied_files.items():
        shutil.copyfile(source, destination)
        os.chmod(destination, 0o600)
    write_json(new_private / 'spec.json', spec)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous-spec', required=True)
    parser.add_argument('--previous-state', required=True)
    parser.add_argument('--output-root', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(clone_spec(args.previous_spec, args.previous_state, args.output_root,
                                args.revision, args.image, args.apply)))


if __name__ == '__main__':
    main()
