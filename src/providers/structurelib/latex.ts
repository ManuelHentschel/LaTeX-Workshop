import * as vscode from 'vscode'
import * as path from 'path'
import type * as Ast from '@unified-latex/unified-latex-types'
import * as lw from '../../lw'
import { TeXElement, TeXElementType } from '../structure'
import { resolveFile } from '../../utils/utils'
import { InputFileRegExp } from '../../utils/inputfilepath'

import { getLogger } from '../../components/logger'
import { parser } from '../../components/parser'

const logger = getLogger('Structure', 'LaTeX')

type StructureConfig = {
    // The LaTeX commands to be extracted.
    macros: {cmds: string[], envs: string[], secs: string[]},
    // The correspondance of section types and depths. Start from zero is
    // the top-most section (e.g., chapter).
    readonly secIndex: {[cmd: string]: number},
    readonly texDirs: string[],
    subFile: boolean
}
type FileStructureCache = {
    [filePath: string]: TeXElement[]
}


export async function construct(filePath: string | undefined = undefined, subFile: boolean = true): Promise<TeXElement[]> {
    filePath = filePath ?? lw.manager.rootFile
    if (filePath === undefined) {
        return []
    }

    const config = refreshLaTeXModelConfig(subFile)
    const structs: FileStructureCache = {}
    await constructFile(filePath, config, structs)
    let struct = subFile ? insertSubFile(structs) : structs[filePath]
    struct = nestNonSection(struct)
    struct = nestSection(struct, config)
    const configuration = vscode.workspace.getConfiguration('latex-workshop')
    if (subFile && configuration.get('view.outline.floats.number.enabled') as boolean) {
        struct = addFloatNumber(struct)
    }
    if (subFile && configuration.get('view.outline.numbers.enabled') as boolean) {
        struct = addSectionNumber(struct, config)
    }
    return struct
}

(globalThis as any).construct = construct

async function constructFile(filePath: string, config: StructureConfig, structs: FileStructureCache): Promise<void> {
    if (structs[filePath]) {
        return
    }
    const openEditor: vscode.TextDocument | undefined = vscode.workspace.textDocuments.filter(document => document.fileName === path.normalize(filePath))?.[0]
    let content: string | undefined
    let ast: Ast.Root | undefined
    if (openEditor?.isDirty) {
        content = openEditor.getText()
        ast = await parser.unifiedParse(content)
    } else {
        let waited = 0
        while (!lw.cacher.promise(filePath) && !lw.cacher.has(filePath)) {
            // Just open vscode, has not cached, wait for a bit?
            await new Promise(resolve => setTimeout(resolve, 100))
            waited++
            if (waited >= 20) {
                // Waited for two seconds before starting cache. Really?
                logger.log(`Error loading cache during structuring: ${filePath} . Forcing.`)
                await lw.cacher.refreshCache(filePath)
                break
            }
        }
        await lw.cacher.promise(filePath)
        content = lw.cacher.get(filePath)?.content
        ast = lw.cacher.get(filePath)?.ast
    }
    if (!content || !ast) {
        logger.log(`Error loading ${content ? 'AST' : 'content'} during structuring: ${filePath} .`)
        return
    }
    // Get a list of rnw child chunks
    const rnwSub = parseRnwChildCommand(content, filePath, lw.manager.rootFile || '')

    // Parse each base-level node. If the node has contents, that function
    // will be called recursively.
    const rootElement = { children: [] }
    for (const node of ast.content) {
        await parseNode(node, rnwSub, rootElement, filePath, config, structs)
    }

    structs[filePath] = rootElement.children
}

function macroToStr(macro: Ast.Macro): string {
    if (macro.content === 'texorpdfstring') {
        return (macro.args?.[1].content[0] as Ast.String | undefined)?.content || ''
    }
    return `\\${macro.content}` + (macro.args?.map(arg => `${arg.openMark}${argContentToStr(arg.content)}${arg.closeMark}`).join('') ?? '')
}

function envToStr(env: Ast.Environment | Ast.VerbatimEnvironment): string {
    return `\\environment{${env.env}}`
}

function argContentToStr(argContent: Ast.Node[]): string {
    return argContent.map(node => {
        // Verb
        switch (node.type) {
            case 'string':
                return node.content
            case 'whitespace':
            case 'parbreak':
            case 'comment':
                return ' '
            case 'macro':
                return macroToStr(node)
            case 'environment':
            case 'verbatim':
            case 'mathenv':
                return envToStr(node)
            case 'inlinemath':
                return `$${argContentToStr(node.content)}$`
            case 'displaymath':
                return `\\[${argContentToStr(node.content)}\\]`
            case 'group':
                return argContentToStr(node.content)
            case 'verb':
                return node.content
            default:
                return ''
        }
    }).join('')
}

async function parseNode(
        node: Ast.Node,
        rnwSub: ReturnType<typeof parseRnwChildCommand>,
        root: { children: TeXElement[] },
        filePath: string,
        config: StructureConfig,
        structs: FileStructureCache) {
    const configuration = vscode.workspace.getConfiguration('latex-workshop')
    const attributes = {
        index: node.position?.start.offset ?? 0,
        lineFr: (node.position?.start.line ?? 1) - 1,
        lineTo: (node.position?.end.line ?? 1) - 1,
        filePath, children: []
    }
    let element: TeXElement | undefined
    if (node.type === 'macro' && config.macros.secs.includes(node.content)) {
        element = {
            type: node.args?.[0]?.content[0] ? TeXElementType.SectionAst : TeXElementType.Section,
            name: node.content,
            label: argContentToStr(((node.args?.[1]?.content?.length ?? 0) > 0 ? node.args?.[1]?.content : node.args?.[2]?.content) || []),
            ...attributes
        }
    } else if (node.type === 'macro' && config.macros.cmds.includes(node.content)) {
        const argStr = argContentToStr(node.args?.[1]?.content || [])
        element = {
            type: TeXElementType.Command,
            name: node.content,
            label: `#${node.content}` + (argStr ? `: ${argStr}` : ''),
            ...attributes
        }
    } else if ((node.type === 'environment') && node.env === 'frame') {
        const frameTitleMacro: Ast.Macro | undefined = node.content.find(sub => sub.type === 'macro' && sub.content === 'frametitle') as Ast.Macro | undefined
        const caption = argContentToStr(node.args?.[3]?.content || []) || argContentToStr(frameTitleMacro?.args?.[2]?.content || [])
        element = {
            type: TeXElementType.Environment,
            name: node.env,
            label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}` + (configuration.get('view.outline.floats.caption.enabled') as boolean && caption ? `: ${caption}` : ''),
            ...attributes
        }
    } else if ((node.type === 'environment') && (
                (node.env === 'figure' || node.env === 'figure*') && config.macros.envs.includes('figure') ||
                (node.env === 'table' || node.env === 'table*') && config.macros.envs.includes('table'))) {
        const captionMacro: Ast.Macro | undefined = node.content.find(sub => sub.type === 'macro' && sub.content === 'caption') as Ast.Macro | undefined
        const caption = argContentToStr(captionMacro?.args?.[1]?.content || [])
        if (node.env.endsWith('*')) {
            node.env = node.env.slice(0, -1)
        }
        element = {
            type: TeXElementType.Environment,
            name: node.env,
            label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}` + (configuration.get('view.outline.floats.caption.enabled') as boolean && caption ? `: ${caption}` : ''),
            ...attributes
        }
    } else if ((node.type === 'environment') && (node.env === 'macro' || node.env === 'environment')) {
        // DocTeX: \begin{macro}{<macro>}
        const caption = (node.content[0] as Ast.Group | undefined)?.content[0] as Ast.String | undefined
        element = {
            type: TeXElementType.Environment,
            name: node.env,
            label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}` + (configuration.get('view.outline.floats.caption.enabled') as boolean && caption ? `: ${caption}` : ''),
            ...attributes
        }
    } else if ((node.type === 'environment' || node.type === 'mathenv') && config.macros.envs.includes(node.env)) {
        element = {
            type: TeXElementType.Environment,
            name: node.env,
            label: `${node.env.charAt(0).toUpperCase()}${node.env.slice(1)}`,
            ...attributes
        }
    } else if (node.type === 'macro' && ['input', 'InputIfFileExists', 'include', 'SweaveInput', 'subfile', 'loadglsentries', 'markdownInput'].includes(node.content)) {
        const arg0 = argContentToStr(node.args?.[0]?.content || [])
        const subFile = resolveFile([ path.dirname(filePath), path.dirname(lw.manager.rootFile || ''), ...config.texDirs ], arg0)
        if (subFile) {
            element = {
                type: TeXElementType.SubFile,
                name: node.content,
                label: config.subFile ? subFile : arg0,
                ...attributes
            }
            if (config.subFile) {
                await constructFile(subFile, config, structs)
            }
        }
    } else if (node.type === 'macro' && ['import', 'inputfrom', 'includefrom'].includes(node.content)) {
        const arg0 = argContentToStr(node.args?.[0]?.content || [])
        const arg1 = argContentToStr(node.args?.[1]?.content || [])
        const subFile = resolveFile([ arg0, path.join(path.dirname(lw.manager.rootFile || ''), arg0 )], arg1)
        if (subFile) {
            element = {
                type: TeXElementType.SubFile,
                name: node.content,
                label: config.subFile ? subFile : arg1,
                ...attributes
            }
            if (config.subFile) {
                await constructFile(subFile, config, structs)
            }
        }
    } else if (node.type === 'macro' && ['subimport', 'subinputfrom', 'subincludefrom'].includes(node.content)) {
        const arg0 = argContentToStr(node.args?.[0]?.content || [])
        const arg1 = argContentToStr(node.args?.[1]?.content || [])
        const subFile = resolveFile([ path.dirname(filePath) ], path.join(arg0, arg1))
        if (subFile) {
            element = {
                type: TeXElementType.SubFile,
                name: node.content,
                label: config.subFile ? subFile : arg1,
                ...attributes
            }
            if (config.subFile) {
                await constructFile(subFile, config, structs)
            }
        }
    }
    if (rnwSub.length > 0 && rnwSub[rnwSub.length - 1].line >= attributes.lineFr) {
        const rnw = rnwSub.pop()
        if (rnw !== undefined) {
            root.children.push({
                type: TeXElementType.SubFile,
                name: 'RnwChild',
                label: config.subFile ? rnw.subFile : rnw.path,
                index: (node.position?.start.offset ?? 1) - 1,
                lineFr: (node.position?.start.line ?? 1) - 1,
                lineTo: (node.position?.end.line ?? 1) - 1,
                filePath, children: []
            })
            if (config.subFile) {
                await constructFile(rnw.subFile, config, structs)
            }
        }
    }
    if (element !== undefined) {
        root.children.push(element)
        root = element
    }
    if ('content' in node && typeof node.content !== 'string') {
        for (const sub of node.content) {
            await parseNode(sub, rnwSub, root, filePath, config, structs)
        }
    }
}

function insertSubFile(structs: FileStructureCache, struct?: TeXElement[]): TeXElement[] {
    if (lw.manager.rootFile === undefined) {
        return []
    }
    struct = struct ?? structs[lw.manager.rootFile] ?? []
    let elements: TeXElement[] = []
    for (const element of struct) {
        if (element.type === TeXElementType.SubFile && structs[element.label]) {
            elements = [...elements, ...insertSubFile(structs, structs[element.label])]
            continue
        }
        if (element.children.length > 0) {
            element.children = insertSubFile(structs, element.children)
        }
        elements.push(element)
    }
    return elements
}

function nestNonSection(struct: TeXElement[]): TeXElement[] {
    const elements: TeXElement[] = []
    let currentSection: TeXElement | undefined
    for (const element of struct) {
        if (element.type === TeXElementType.Section || element.type === TeXElementType.SectionAst) {
            elements.push(element)
            currentSection = element
        } else if (currentSection === undefined) {
            elements.push(element)
        } else {
            currentSection.children.push(element)
        }
        if (element.children.length > 0) {
            element.children = nestNonSection(element.children)
        }
    }
    return elements
}

function nestSection(struct: TeXElement[], config: StructureConfig): TeXElement[] {
    const stack: TeXElement[] = []
    const elements: TeXElement[] = []
    for (const element of struct) {
        if (element.type !== TeXElementType.Section && element.type !== TeXElementType.SectionAst && element.type !== TeXElementType.SubFile) {
            elements.push(element)
        } else if (stack.length === 0) {
            stack.push(element)
            elements.push(element)
        } else if (config.secIndex[element.name] <= config.secIndex[stack[0].name]) {
            stack.length = 0
            stack.push(element)
            elements.push(element)
        } else if (config.secIndex[element.name] > config.secIndex[stack[stack.length - 1].name]) {
            stack[stack.length - 1].children.push(element)
            stack.push(element)
        } else {
            while(config.secIndex[element.name] <= config.secIndex[stack[stack.length - 1].name]) {
                stack.pop()
            }
            stack[stack.length - 1].children.push(element)
            stack.push(element)
        }
    }
    return elements
}

function addFloatNumber(struct: TeXElement[], counter: {[env: string]: number} = {}): TeXElement[] {
    for (const element of struct) {
        if (element.type === TeXElementType.Environment && element.name !== 'macro' && element.name !== 'environment') {
            counter[element.name] = (counter[element.name] ?? 0) + 1
            const parts = element.label.split(':')
            parts[0] += ` ${counter[element.name].toString()}`
            element.label = parts.join(':')
        }
        if (element.children.length > 0) {
            addFloatNumber(element.children, counter)
        }
    }
    return struct
}

function addSectionNumber(struct: TeXElement[], config: StructureConfig, tag?: string, lowest?: number): TeXElement[] {
    tag = tag ?? ''
    lowest = lowest ?? Math.min(...struct
        .filter(element => config.secIndex[element.name] !== undefined)
        .map(element => config.secIndex[element.name]))
    const counter: {[level: number]: number} = {}
    for (const element of struct) {
        if (config.secIndex[element.name] === undefined) {
            continue
        }
        if (element.type === TeXElementType.Section) {
            counter[config.secIndex[element.name]] = (counter[config.secIndex[element.name]] ?? 0) + 1
        }
        const sectionNumber = tag +
            '0.'.repeat(config.secIndex[element.name] - lowest) +
            counter[config.secIndex[element.name]].toString()
        element.label = `${element.type === TeXElementType.Section ? sectionNumber : '*'} ${element.label}`
        if (element.children.length > 0) {
            addSectionNumber(element.children, config, sectionNumber + '.', config.secIndex[element.name] + 1)
        }
    }
    return struct
}

/**
 * OLD STRUCTURING AS OF MAY 12, 2023
 */

function parseRnwChildCommand(content: string, file: string, rootFile: string): {subFile: string, path: string, line: number}[] {
    const children: {subFile: string, path: string, line: number}[] = []
    const childRegExp = new InputFileRegExp()
    while(true) {
        const result = childRegExp.execChild(content, file, rootFile)
        if (!result) {
            break
        }
        const line = (content.slice(0, result.match.index).match(/\n/g) || []).length
        children.push({subFile: result.path, path: result.match.path, line})
    }
    return children
}

function refreshLaTeXModelConfig(subFile: boolean = true, defaultFloats = ['frame']): StructureConfig {
    const configuration = vscode.workspace.getConfiguration('latex-workshop')
    const cmds = configuration.get('view.outline.commands') as string[]
    const envs = configuration.get('view.outline.floats.enabled') as boolean ? ['figure', 'table', ...defaultFloats] : defaultFloats
    const texDirs = vscode.workspace.getConfiguration('latex-workshop').get('latex.texDirs') as string[]

    const structConfig: StructureConfig = {
        macros: {cmds, envs, secs: []},
        secIndex: {},
        texDirs,
        subFile
    }

    const hierarchy = (configuration.get('view.outline.sections') as string[])
    hierarchy.forEach((sec, index) => {
        sec.split('|').forEach(cmd => {
            structConfig.secIndex[cmd] = index
        })
    })

    structConfig.macros.secs = hierarchy.map(sec => sec.split('|')).flat()

    return structConfig
}

export const outline = {
    refreshLaTeXModelConfig,
    parseNode,
    nestNonSection,
    nestSection,
    addFloatNumber,
    addSectionNumber
}
