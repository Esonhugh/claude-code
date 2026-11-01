import path from 'node:path';

// Pinned sources of the bfs/ugrep embedded in Linux and macOS binaries.
// ugrep and bfs match the versions official 2.1.311 embeds.
export const SEARCH_TOOL_SOURCES = [
  {
    name: 'pcre2',
    repo: 'https://github.com/PCRE2Project/pcre2',
    tag: 'pcre2-10.47',
    commit: 'f454e231fe5006dd7ff8f4693fd2b8eb94333429',
    submodules: true,
  },
  {
    name: 'oniguruma',
    repo: 'https://github.com/kkos/oniguruma',
    tag: 'v6.9.10',
    commit: '4ef89209a239c1aea328cf13c05a2807e5c146d1',
  },
  {
    name: 'ugrep',
    repo: 'https://github.com/Genivia/ugrep',
    tag: 'v7.8.4',
    commit: '550599a6434fc5315fb6ecd415a5d859e6d846a8',
  },
  {
    name: 'bfs',
    repo: 'https://github.com/tavianator/bfs',
    tag: '4.1.1',
    commit: 'f220fb5afd8dd7f46b1d1a2ae9c36261eaccf3cd',
  },
];

export const SEARCH_TOOLS_VERSION = 'ugrep-7.8.4-bfs-4.1.1';

export function searchToolsDir(projectDir, platform, arch) {
  return path.join(
    projectDir,
    'dist',
    'search-tools',
    `${SEARCH_TOOLS_VERSION}-${platform}-${arch}`,
  );
}
