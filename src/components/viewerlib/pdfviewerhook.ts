import type * as vscode from 'vscode'
import * as lw from '../../lw'

class PdfViewerHookProvider implements vscode.CustomReadonlyEditorProvider {
    openCustomDocument(uri: vscode.Uri) {
        return {
            uri,
            dispose: () => {}
        }
    }

    resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel) {
        webviewPanel.webview.options = {
            ...webviewPanel.webview.options,
            enableScripts: true
        }
        void lw.viewer.openPdfInTab(document.uri, webviewPanel)
    }
}

export const pdfViewerHookProvider = new PdfViewerHookProvider()
