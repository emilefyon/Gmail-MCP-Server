import fs from 'fs';
import path from 'path';

/**
 * Turns a filename taken from an email into a safe basename.
 * The sender controls this value, so it never decides the directory.
 */
export function safeFilename(name: string, fallback: string): string {
    let cleaned = path.basename(name.replace(/\\/g, '/'))
        // Control characters and characters that are awkward on macOS/Windows
        .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
        .trim()
        // No hidden files such as .zshrc or .git
        .replace(/^\.+/, '');
    if (!cleaned || cleaned === '.' || cleaned === '..') {
        cleaned = fallback;
    }
    return cleaned.slice(0, 200);
}

/**
 * Resolves `relativeDir` inside `root` and refuses anything that ends up outside it.
 * Each folder is checked before it is created, so a symlink cannot lead outside the root.
 */
export function resolveInside(root: string, relativeDir: string): string {
    if (path.isAbsolute(relativeDir)) {
        throw new Error('savePath must be relative to the download root');
    }
    const realRoot = fs.realpathSync(root);
    const relative = path.relative(realRoot, path.resolve(realRoot, relativeDir));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('savePath points outside the download root');
    }

    let current = realRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        // Hidden folders (.git, .ssh, .claude ...) are off limits
        if (part.startsWith('.')) {
            throw new Error('savePath may not contain hidden folders');
        }
        current = path.join(current, part);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stat) {
            fs.mkdirSync(current);
        } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`savePath goes through a symlink or a file: ${part}`);
        }
    }
    return current;
}

/**
 * Writes the file without ever overwriting: "report.pdf" becomes "report (1).pdf" if needed.
 */
export function writeNew(dir: string, filename: string, data: Buffer): string {
    const ext = path.extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    for (let i = 0; i < 100; i++) {
        const candidate = path.join(dir, i === 0 ? filename : `${stem} (${i})${ext}`);
        try {
            fs.writeFileSync(candidate, data, { flag: 'wx', mode: 0o644 });
            return candidate;
        } catch (error: any) {
            if (error.code !== 'EEXIST') throw error;
        }
    }
    throw new Error(`Too many files named ${filename} in ${dir}`);
}
