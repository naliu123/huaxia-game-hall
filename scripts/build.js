import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const allApps = ['gobang', 'doudizhu', 'mahjong', 'admin'];
const apps = process.env.BUILD_APP ? [process.env.BUILD_APP] : allApps;
if (apps.some(app => !allApps.includes(app))) throw new Error(`Unknown BUILD_APP: ${process.env.BUILD_APP}`);

if (process.env.BUILD_APP) {
  await rm(path.join(dist, 'apps', process.env.BUILD_APP), { recursive: true, force: true });
} else {
  await rm(dist, { recursive: true, force: true });
}
await mkdir(path.join(dist, 'apps'), { recursive: true });

for (const app of apps) {
  const target = path.join(dist, 'apps', app);
  await mkdir(target, { recursive: true });
  await cp(path.join(root, 'src', 'apps', app), target, { recursive: true });
  await cp(path.join(root, 'src', 'shared'), path.join(target, 'shared'), {
    recursive: true,
  });
}

await cp(path.join(root, 'src', 'server'), path.join(dist, 'server'), {
  recursive: true,
});
await cp(path.join(root, 'src', 'games'), path.join(dist, 'games'), { recursive: true });
await cp(path.join(root, 'src', 'room-manager.js'), path.join(dist, 'room-manager.js'));
await cp(path.join(root, 'src', 'realtime-server.js'), path.join(dist, 'realtime-server.js'));

console.log(`Built ${apps.length} independent applications: ${apps.join(', ')}`);
