import * as vscode from 'vscode'
import * as fs from 'fs'

import * as ppath from 'path'
import * as git from './git'
import * as cp from 'child_process'
import { promisify } from 'util'

export class LwFileSystem {
    isLocalUri(uri: vscode.Uri): boolean {
        return uri.scheme === 'file'
    }

    isVirtualUri(uri: vscode.Uri): boolean {
        return !this.isLocalUri(uri)
    }

    async exists(uri: vscode.Uri): Promise<boolean> {
        try {
            if (this.isLocalUri(uri)) {
                return fs.existsSync(uri.fsPath)
            } else {
                await vscode.workspace.fs.stat(uri)
                return true
            }
        } catch {
            return false
        }
    }

    async readFile(fileUri: vscode.Uri): Promise<string> {
        const result = await this.readFileAsBuffer(fileUri)
        return result.toString()
    }

    async readFileAsBuffer(fileUri: vscode.Uri): Promise<Buffer> {
        if (this.isLocalUri(fileUri)) {
            return fs.promises.readFile(fileUri.fsPath)
        } else if(fileUri.scheme === 'git') {
            return readGitFile(fileUri)
        } else {
            const resultUint8 = await vscode.workspace.fs.readFile(fileUri)
            return Buffer.from(resultUint8)
        }
    }

    readFileSyncGracefully(filepath: string): string | undefined {
        try {
            const ret = fs.readFileSync(filepath).toString()
            return ret
        } catch (err) {
            return
        }
    }

    async stat(fileUri: vscode.Uri): Promise<fs.Stats | vscode.FileStat> {
        if (this.isLocalUri(fileUri)) {
            return fs.statSync(fileUri.fsPath)
        } else {
            return vscode.workspace.fs.stat(fileUri)
        }
    }

}

async function readGitFile(uri: vscode.Uri): Promise<Buffer> {
    const gitExtension = vscode.extensions.getExtension<git.GitExtension>('vscode.git')
    if(!gitExtension) {
        throw new Error('Git extension not installed or not activated!')
    }
    const api = gitExtension.exports.getAPI(1)
    const repo = api.getRepository(uri)
    if(!repo){
        throw new Error(`Did not find repo for uri: ${uri.toString()}}`)
    }
    const {path, ref} = JSON.parse(uri.query) as {path: string, ref: string}
    const fixRef = ref.replace(/^~/, 'HEAD')
    const relPath = ppath.relative(repo.rootUri.fsPath, path).replaceAll('\\', '/')
    const cmd = `git show ${fixRef}:${relPath}`
    const options = {
        encoding: 'buffer' as const,
        cwd: repo.rootUri.fsPath
    }
    const ret = await promisify(cp.exec)(cmd, options)
    return ret.stdout
}
