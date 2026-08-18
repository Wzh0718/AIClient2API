import fs from 'fs';
import path from 'path';

test('worker runtime metrics include image capacity state', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/services/api-server.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(source).toContain("import { runtimeImageCapacity } from '../runtime/runtime-image-capacity.js'");
    expect(source).toContain('imageCapacity: runtimeImageCapacity.snapshot()');
});
