import sharpAddonAsset from __CLAUDE_CODE_SHARP_ADDON__ with { type: 'file' };
import sharpLibraryAsset from __CLAUDE_CODE_SHARP_LIBRARY__ with { type: 'file' };
import sharpSecondaryLibraryAsset from __CLAUDE_CODE_SHARP_SECONDARY_LIBRARY__ with { type: 'file' };
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let loadPromise;
globalThis.__CLAUDE_CODE_LOAD_SHARP_NATIVE__ = () =>
  (loadPromise ??= loadSharpNative());

async function loadSharpNative() {
  const extractionRoot = path.join(tmpdir(), 'claude-code-sharp');
  mkdirSync(extractionRoot, { recursive: true });
  if (process.platform === 'win32') {
    for (const entry of readdirSync(extractionRoot)) {
      const pid = Number(entry.match(/^(\d+)-/)?.[1]);
      if (!Number.isInteger(pid)) continue;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code !== 'ESRCH') continue;
        try {
          rmSync(path.join(extractionRoot, entry), {
            recursive: true,
            force: true,
          });
        } catch {}
      }
    }
  }

  const extractionDirectory = mkdtempSync(
    path.join(extractionRoot, `${process.pid}-`),
  );
  const platformArch = __CLAUDE_CODE_SHARP_PLATFORM_ARCH__;
  const packageRoot = path.join(extractionDirectory, 'node_modules', '@img');
  const addonDirectory = path.join(packageRoot, `sharp-${platformArch}`, 'lib');
  const libraryPackage = platformArch.startsWith('win32-')
    ? `sharp-${platformArch}`
    : `sharp-libvips-${platformArch}`;
  const libraryDirectory = path.join(packageRoot, libraryPackage, 'lib');
  const addonPath = path.join(
    addonDirectory,
    __CLAUDE_CODE_SHARP_ADDON_NAME__,
  );

  const cleanup = () => {
    try {
      rmSync(extractionDirectory, { recursive: true, force: true });
    } catch {}
  };

  try {
    mkdirSync(addonDirectory, { recursive: true });
    mkdirSync(libraryDirectory, { recursive: true });
    writeFileSync(
      addonPath,
      Buffer.from(await Bun.file(sharpAddonAsset).arrayBuffer()),
    );
    const libraries = [
      [sharpLibraryAsset, __CLAUDE_CODE_SHARP_LIBRARY_NAME__],
    ];
    if (
      __CLAUDE_CODE_SHARP_SECONDARY_LIBRARY_NAME__ !==
      __CLAUDE_CODE_SHARP_LIBRARY_NAME__
    ) {
      libraries.push([
        sharpSecondaryLibraryAsset,
        __CLAUDE_CODE_SHARP_SECONDARY_LIBRARY_NAME__,
      ]);
    }
    for (const [assetPath, name] of libraries) {
      writeFileSync(
        path.join(libraryDirectory, name),
        Buffer.from(await Bun.file(assetPath).arrayBuffer()),
      );
    }
    const nativeModule = { exports: {} };
    process.dlopen(nativeModule, addonPath);
    globalThis.__CLAUDE_CODE_SHARP_NATIVE__ = nativeModule.exports;
  } finally {
    if (
      process.platform === 'win32' &&
      globalThis.__CLAUDE_CODE_SHARP_NATIVE__
    ) {
      process.once('exit', cleanup);
    } else {
      cleanup();
    }
  }
}
