#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const owner = process.env.NODEJS_MOBILE_OWNER || 'funnycups';
const repo = process.env.NODEJS_MOBILE_REPO || 'nodejs-mobile';
const requestedTag = process.env.NODEJS_MOBILE_TAG || 'v1.0.1';
const minMajor = Number.parseInt(process.env.NODEJS_MOBILE_MIN_MAJOR || '24', 10);
const enforceMinMajor = (process.env.NODEJS_MOBILE_ENFORCE_MIN_MAJOR || '1') !== '0';
const defaultAssetUrl = 'https://github.com/funnycups/nodejs-mobile/releases/download/v1.0.1/nodejs-mobile-android.zip';
const directAssetUrl = (process.env.NODEJS_MOBILE_ASSET_URL || defaultAssetUrl).trim();
const directAssetName = (process.env.NODEJS_MOBILE_ASSET_NAME || '').trim();
const localAssetFileInput = (process.env.NODEJS_MOBILE_ASSET_FILE || '').trim();
const runtimeMajorOverrideRaw = (process.env.NODEJS_MOBILE_RUNTIME_MAJOR || '').trim();
const runtimeMajorOverride = runtimeMajorOverrideRaw
    ? Number.parseInt(runtimeMajorOverrideRaw, 10)
    : null;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRootDir = path.resolve(scriptDir, '..', '..');
const appDir = path.join(repoRootDir, 'android-app', 'app');
const libnodeDir = path.join(appDir, 'libnode');
const jniLibsDir = path.join(appDir, 'src/main/jniLibs');
const defaultLocalAssetPath = path.join(repoRootDir, 'nodejs-mobile-android.zip');

function escapePowerShellSingleQuoted(value) {
    return value.replaceAll("'", "''");
}

function extractArchive(archivePath, extractDir) {
    if (/\.(tar\.gz|tgz)$/i.test(archivePath)) {
        execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' });
        return;
    }

    if (process.platform === 'win32') {
        const literalArchive = escapePowerShellSingleQuoted(archivePath);
        const literalExtract = escapePowerShellSingleQuoted(extractDir);
        execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `Expand-Archive -LiteralPath '${literalArchive}' -DestinationPath '${literalExtract}' -Force`,
            ],
            { stdio: 'inherit' },
        );
        return;
    }

    execFileSync('unzip', ['-q', archivePath, '-d', extractDir], { stdio: 'inherit' });
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        const headers = {
            'User-Agent': 'luker-android-runtime-fetch',
            'Accept': 'application/vnd.github+json',
        };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        const req = https.get(url, { headers }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                requestJson(res.headers.location).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`GitHub API request failed: ${res.statusCode} for ${url}`));
                return;
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
    });
}

function parseNodeMajor(text) {
    if (!text) {
        return null;
    }
    const match = String(text).match(/v?(\d+)\.\d+\.\d+/);
    if (!match) {
        return null;
    }
    const major = Number.parseInt(match[1], 10);
    return Number.isFinite(major) ? major : null;
}

async function resolveRelease() {
    if (!requestedTag || requestedTag === 'latest') {
        return requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
    }
    return requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(requestedTag)}`);
}

async function resolveDownloadTarget() {
    if (localAssetFileInput) {
        const resolvedPath = path.isAbsolute(localAssetFileInput)
            ? localAssetFileInput
            : path.resolve(process.cwd(), localAssetFileInput);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`NODEJS_MOBILE_ASSET_FILE does not exist: ${resolvedPath}`);
        }
        return {
            mode: 'local-file',
            releaseTag: requestedTag || 'local-file',
            assetName: directAssetName || path.basename(resolvedPath),
            localPath: resolvedPath,
        };
    }

    // Developer convenience: if a local runtime zip exists at repo root, use it directly.
    if (fs.existsSync(defaultLocalAssetPath)) {
        return {
            mode: 'local-file',
            releaseTag: requestedTag || 'local-file',
            assetName: directAssetName || path.basename(defaultLocalAssetPath),
            localPath: defaultLocalAssetPath,
        };
    }

    if (directAssetUrl) {
        let derivedName = 'nodejs-mobile-android.zip';
        try {
            const parsed = new URL(directAssetUrl);
            const base = path.basename(parsed.pathname || '');
            if (base) {
                derivedName = base;
            }
        } catch {
            // keep default name
        }
        return {
            mode: 'direct-url',
            releaseTag: requestedTag || 'direct-url',
            assetName: directAssetName || derivedName,
            downloadUrl: directAssetUrl,
        };
    }

    try {
        const release = await resolveRelease();
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const preferred = assets.find(a => /android/i.test(a.name) && /\.(zip|tar\.gz|tgz)$/i.test(a.name));
        if (!preferred?.browser_download_url) {
            throw new Error(`Unable to find Android asset in ${owner}/${repo}@${release.tag_name || requestedTag}`);
        }
        return {
            mode: 'release-asset',
            releaseTag: String(release.tag_name || requestedTag),
            assetName: preferred.name,
            downloadUrl: preferred.browser_download_url,
        };
    } catch (error) {
        if (!requestedTag || requestedTag === 'latest') {
            throw error;
        }

        // Fallback for forks that expose Node updates as a branch but don't publish release assets.
        const branchArchiveUrl = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(requestedTag)}`;
        return {
            mode: 'branch-archive',
            releaseTag: requestedTag,
            assetName: `${repo}-${requestedTag}.zip`,
            downloadUrl: branchArchiveUrl,
        };
    }
}

function parseNodeMajorFromHeader(nodeVersionHeaderPath) {
    if (!nodeVersionHeaderPath || !fs.existsSync(nodeVersionHeaderPath)) {
        return null;
    }
    const content = fs.readFileSync(nodeVersionHeaderPath, 'utf8');
    const match = content.match(/^\s*#define\s+NODE_MAJOR_VERSION\s+(\d+)\s*$/m);
    if (!match) {
        return null;
    }
    const major = Number.parseInt(match[1], 10);
    return Number.isFinite(major) ? major : null;
}

function download(url, target) {
    return new Promise((resolve, reject) => {
        const headers = { 'User-Agent': 'luker-android-runtime-fetch' };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        https.get(url, { headers }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                download(res.headers.location, target).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Download failed: ${res.statusCode}`));
                return;
            }

            const file = fs.createWriteStream(target);
            file.on('error', (err) => {
                try {
                    if (fs.existsSync(target)) {
                        fs.unlinkSync(target);
                    }
                } catch {
                    // no-op
                }
                reject(err);
            });
            file.on('finish', () => file.close(() => resolve()));
            res.pipe(file);
        }).on('error', (err) => {
            try {
                if (fs.existsSync(target)) {
                    fs.unlinkSync(target);
                }
            } catch {
                // no-op
            }
            reject(err);
        });
    });
}

function removeDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function findFirstFile(rootDir, fileName) {
    const stack = [rootDir];
    while (stack.length) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile() && entry.name === fileName) {
                return full;
            }
        }
    }
    return null;
}

function findAllFiles(rootDir, fileName) {
    const files = [];
    const stack = [rootDir];
    while (stack.length) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile() && entry.name === fileName) {
                files.push(full);
            }
        }
    }
    return files;
}

function detectAbi(filePath) {
    const normalized = filePath.replaceAll('\\', '/');
    if (normalized.includes('arm64-v8a') || normalized.includes('android-arm64')) {
        return 'arm64-v8a';
    }
    if (normalized.includes('armeabi-v7a') || normalized.includes('android-arm')) {
        return 'armeabi-v7a';
    }
    if (normalized.includes('x86_64') || normalized.includes('android-x64')) {
        return 'x86_64';
    }
    if (normalized.includes('/x86/') || normalized.includes('android-x86')) {
        return 'x86';
    }
    return null;
}

async function main() {
    const target = await resolveDownloadTarget();
    const releaseTag = target.releaseTag;
    if (enforceMinMajor && !Number.isFinite(minMajor)) {
        throw new Error(`Invalid NODEJS_MOBILE_MIN_MAJOR value: ${process.env.NODEJS_MOBILE_MIN_MAJOR}`);
    }

    let runtimeMajor = Number.isFinite(runtimeMajorOverride)
        ? runtimeMajorOverride
        : (parseNodeMajor(releaseTag) ?? parseNodeMajor(target.assetName));

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-nodejs-mobile-'));
    const archivePath = path.join(tempRoot, target.assetName);
    const extractDir = path.join(tempRoot, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });

    if (target.mode === 'local-file') {
        fs.copyFileSync(target.localPath, archivePath);
    } else {
        await download(target.downloadUrl, archivePath);
    }

    extractArchive(archivePath, extractDir);

    removeDir(libnodeDir);
    removeDir(jniLibsDir);
    fs.mkdirSync(libnodeDir, { recursive: true });
    fs.mkdirSync(jniLibsDir, { recursive: true });

    const nodeHeader = findFirstFile(extractDir, 'node.h');
    if (!nodeHeader) {
        throw new Error('node.h not found in extracted Node.js Mobile package');
    }

    const includeNodeDir = path.dirname(nodeHeader);
    const includeDir = path.dirname(includeNodeDir);
    fs.cpSync(includeDir, path.join(libnodeDir, 'include'), { recursive: true });

    if (runtimeMajor == null) {
        runtimeMajor = parseNodeMajorFromHeader(path.join(includeNodeDir, 'node_version.h'));
    }
    if (enforceMinMajor) {
        if (runtimeMajor == null) {
            throw new Error(
                `Unable to determine Node major version from release '${releaseTag}' / asset '${target.assetName}'. ` +
                'Set NODEJS_MOBILE_RUNTIME_MAJOR (e.g. 24) or NODEJS_MOBILE_ENFORCE_MIN_MAJOR=0 to bypass.',
            );
        }
        if (runtimeMajor < minMajor) {
            throw new Error(
                `Resolved Node runtime ${runtimeMajor} from ${owner}/${repo}@${releaseTag}, ` +
                `but NODEJS_MOBILE_MIN_MAJOR=${minMajor}.`,
            );
        }
    }

    const soFiles = findAllFiles(extractDir, 'libnode.so');
    if (!soFiles.length) {
        throw new Error(
            `libnode.so not found in extracted package (${target.mode}). ` +
            `If using a branch archive, publish a release with Android binaries or provide a ref that contains prebuilt libnode.so.`,
        );
    }

    let copied = 0;
    for (const soPath of soFiles) {
        const abi = detectAbi(soPath);
        if (!abi) {
            continue;
        }
        const abiDir = path.join(jniLibsDir, abi);
        fs.mkdirSync(abiDir, { recursive: true });
        fs.copyFileSync(soPath, path.join(abiDir, 'libnode.so'));
        copied++;
    }

    if (!copied) {
        throw new Error('Failed to map libnode.so to Android ABIs');
    }

    const copiedAbis = fs.readdirSync(jniLibsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    console.log(`Prepared Android ABIs: ${copiedAbis.join(', ')}`);

    const marker = path.join(libnodeDir, 'VERSION');
    const refLine = target.mode === 'local-file'
        ? `local/${path.basename(target.localPath)}`
        : `${owner}/${repo}@${releaseTag}`;
    fs.writeFileSync(marker, `${refLine}\nasset=${target.assetName}\nsource=${target.mode}\nnode_major=${runtimeMajor ?? 'unknown'}\n`);
    console.log(`Node.js Mobile prepared from ${target.assetName} (${target.mode}, ${releaseTag}, node_major=${runtimeMajor ?? 'unknown'})`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
