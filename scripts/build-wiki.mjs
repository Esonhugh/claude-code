import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

// Publishes docs/features/ as GitHub Wiki pages: README.md becomes Home,
// `agent-teams.md` becomes `Agent-Teams`, and links leaving docs/features/
// point at the source tree on GitHub.
const [outDir, blobBase] = process.argv.slice(2);
if (!outDir || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[\w./-]+$/.test(blobBase ?? '')) {
  console.error('usage: build-wiki.mjs <out-dir> https://github.com/<owner>/<repo>/blob/<ref>');
  process.exit(1);
}
const srcDir = new URL('../docs/features/', import.meta.url);
const files = fs.readdirSync(srcDir).filter(name => name.endsWith('.md')).sort();
const pageName = file =>
  file === 'README.md'
    ? 'Home'
    : file.replace(/\.md$/, '').split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('-');

const rewriteLink = target => {
  if (/^([a-z]+:|#)/i.test(target)) return target;
  const [file, anchor] = target.split('#');
  const suffix = anchor === undefined ? '' : `#${anchor}`;
  if (!file.includes('/') && files.includes(file)) return pageName(file) + suffix;
  const repoPath = path.posix.normalize(path.posix.join('docs/features', file));
  if (repoPath.startsWith('../')) return target;
  // Wiki pages embed images, so those need the raw file rather than the blob page.
  const base = /\.(png|jpe?g|gif|svg|webp)$/i.test(file) ? blobBase.replace('/blob/', '/raw/') : blobBase;
  return `${base}/${repoPath}${suffix}`;
};

fs.mkdirSync(outDir, { recursive: true });
const sidebar = ['**[功能索引](Home)**', ''];
for (const file of files) {
  const text = fs.readFileSync(new URL(file, srcDir), 'utf8');
  const body = text.replace(/\]\(([^)\s]+)\)/g, (_, target) => `](${rewriteLink(target)})`);
  const source = `\n\n---\n\n本页由 [docs/features/${file}](${blobBase}/docs/features/${file}) 自动同步，请在仓库中修改。\n`;
  fs.writeFileSync(path.join(outDir, `${pageName(file)}.md`), body.trimEnd() + source);
  if (file === 'README.md') continue;
  const title = text.match(/^# (.+)$/m)?.[1] ?? pageName(file);
  sidebar.push(`- [${title}](${pageName(file)})`);
}
fs.writeFileSync(path.join(outDir, '_Sidebar.md'), sidebar.join('\n') + '\n');
console.log(`Wrote ${files.length} wiki pages to ${outDir}.`);
