#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execSync } from 'node:child_process';

const owner = process.env.NODEJS_MOBILE_OWNER || 'nodejs-mobile';
const repo = process.env.NODEJS_MOBILE_REPO || 'nodejs-mobile';
const tag = process.env.NODEJS_MOBILE_TAG || 'v18.20.4';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const appDir = path.resolve('android-app/app');
const libnodeDir = path.join(appDir, 'libnode');
const jniLibsDir = path.join(appDir, 'src/main/jniLibs');

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
                reject(new Error(`GitHub API request failed: ${res.statusCode}`));
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

function download(url, target) {
    return new Promise((resolve, reject) => {
        const headers = { 'User-Agent': 'luker-android-runtime-fetch' };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        const file = fs.createWriteStream(target);
        https.get(url, { headers }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                download(res.headers.location, target).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Download failed: ${res.statusCode}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlinkSync(target);
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
    if (normalized.includes('/x86/')) {
        return 'x86';
    }
    return null;
}

async function main() {
    const release = await requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const preferred = assets.find(a => /android/i.test(a.name) && /\.(zip|tar\.gz|tgz)$/i.test(a.name));
    if (!preferred?.browser_download_url) {
        throw new Error(`Unable to find Android asset in ${owner}/${repo}@${tag}`);
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-nodejs-mobile-'));
    const archivePath = path.join(tempRoot, preferred.name);
    const extractDir = path.join(tempRoot, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });

    await download(preferred.browser_download_url, archivePath);

    if (/\.(tar\.gz|tgz)$/i.test(archivePath)) {
        execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, { stdio: 'inherit' });
    } else {
        execSync(`unzip -q "${archivePath}" -d "${extractDir}"`, { stdio: 'inherit' });
    }

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

    const soFiles = findAllFiles(extractDir, 'libnode.so');
    if (!soFiles.length) {
        throw new Error('libnode.so not found in extracted Node.js Mobile package');
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

    const marker = path.join(libnodeDir, 'VERSION');
    fs.writeFileSync(marker, `${owner}/${repo}@${tag}\nasset=${preferred.name}\n`);
    console.log(`Node.js Mobile prepared from ${preferred.name}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
