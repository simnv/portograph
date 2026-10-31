// Is Verdana installed on this machine? The CLI warns when it is not. The library never asks: its output is a
// pure function of the document, and the text is measured from the checked-in Verdana advances either way.
// The check is cheap and best effort: it looks in the usual font directories of macOS, Linux and Windows,
// three levels deep, for a file named like Verdana. A font that only a font server or an application knows is missed.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILE = /^verdana.*\.(ttf|otf|ttc)$/i;
const DEPTH = 3;

/** The usual font directories of the platform. `PORTOGRAPH_FONT_DIRS` (a path-delimited list) replaces them; tests use it. */
export function fontDirectories(platform = process.platform, env = process.env, home = homedir()) {
  if (env.PORTOGRAPH_FONT_DIRS !== undefined) return env.PORTOGRAPH_FONT_DIRS.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'darwin') {
    return ['/System/Library/Fonts/Supplemental', '/System/Library/Fonts', '/Library/Fonts', join(home, 'Library/Fonts')];
  }
  if (platform === 'win32') {
    const windows = env.WINDIR ?? env.SystemRoot ?? 'C:\\Windows';
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [join(windows, 'Fonts'), join(local, 'Microsoft', 'Windows', 'Fonts')];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.fonts'), join(home, '.local/share/fonts')];
}

function linksToFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    // A broken link holds no font.
    return false;
  }
}

function hasVerdana(directory, depth) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // An absent or unreadable directory holds no font for this check; "not found" is reported only after all of them.
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && FILE.test(entry.name)) return true;
    // A font manager (Homebrew casks, Nix, fontconfig setups) can link a font file into the directory; the link counts when it ends at a file.
    if (entry.isSymbolicLink() && FILE.test(entry.name) && linksToFile(join(directory, entry.name))) return true;
    if (entry.isDirectory() && depth > 1 && hasVerdana(join(directory, entry.name), depth - 1)) return true;
  }
  return false;
}

/** True when a Verdana file sits in one of `directories` (default: the usual ones of this platform). */
export function verdanaInstalled(directories = fontDirectories()) {
  return directories.some((directory) => hasVerdana(directory, DEPTH));
}

export const VERDANA_WARNING =
  'Verdana is not installed on this machine. Text is measured from Verdana, so a viewer without it draws text that can overflow its box. Install Verdana (see the README).';
