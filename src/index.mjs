// @ts-check
'use strict';

import { commands, workspace, Range, window, ThemeColor } from 'vscode';
import { getTextMatch, buildMatchers } from './utils.mjs';
import { spawn } from 'child_process';
import { rustyWindPath } from 'rustywind';
import { getTailwindConfig } from './config.mjs';
import { sortClasses } from './sorting.mjs';
// import resolve from 'path' and rename it to resolvePath
import { resolve as resolvePath, isAbsolute as isPathAbsolute } from 'path';

/**
 * @typedef {import('vscode').ExtensionContext} ExtensionContext
 */

/**
 * @typedef {string | string[] | { regex?: string | string[]; separator?: string; replacement?: string } | undefined} LangConfig
 */

/**
 * @param {import('vscode').WorkspaceFolder} workspaceFolder
 * @param {string} path
 */
function expandRelativePath(workspaceFolder, path) {
	return isPathAbsolute(path) ? path : resolvePath(workspaceFolder.uri.fsPath, path);
}

const config = workspace.getConfiguration();
/** @type {{ [key: string]: LangConfig | LangConfig[] }} */
const langConfig =
  config.get('tailwind-raw-reorder.classRegex') || {};
/** @type {{ string: boolean } | undefined} */
const IgnoreConfigNotFound =
  config.get('tailwind-raw-reorder.IgnoreConfigNotFound');
/** @type {import('vscode').WorkspaceFolder | undefined} */
const workspaceFolder = (workspace.workspaceFolders || [])[0];
/** @type {string | undefined} */
const rawTailwindConfigPath = config.get('tailwind-raw-reorder.tailwindConfigPath') ?? undefined;
const tailwindConfigPath =
(workspaceFolder && rawTailwindConfigPath && expandRelativePath(workspaceFolder, rawTailwindConfigPath));
const outputLogChannel = window.createOutputChannel('Tailwind Raw Reorder');

let currentHighlightColor = 'textLink.activeForeground'; // Default value
let currentHighlightTimeout = 7000; // Default value in milliseconds

/**
 * @type {import("vscode").TextEditorDecorationType[]}
 */
let activeDecorationTypes = []; // Store the active decoration type

/**
 * @param {ExtensionContext} context
 */
export function activate(context) {
	if (!workspaceFolder) { // if we don't have a workspace folder, we should not run the extension
		// log that no workspace was found
		const message = 'No workspace found';
		outputLogChannel.appendLine(message);
		return;
	}

  // Register the listener for configuration changes
  workspace.onDidChangeConfiguration((event) => {
    // Handle highlightColor changes
    if (event.affectsConfiguration('tailwind-raw-reorder.highlightColor')) {
      currentHighlightColor = workspace
        .getConfiguration('tailwind-raw-reorder')
        .get('highlightColor', 'textLink.activeForeground');
      clearDecorations();
    }

    // Handle highlightTimeout changes
    if (event.affectsConfiguration('tailwind-raw-reorder.highlightTimeout')) {
      currentHighlightTimeout = workspace
        .getConfiguration('tailwind-raw-reorder')
        .get('highlightTimeout', 7) * 1000; // Convert seconds to milliseconds
    }
  });

  let disposable = commands.registerTextEditorCommand(
    'tailwind-raw-reorder.sortTailwindClasses',
    function (editor, edit) {
      const editorText = editor.document.getText();
      const editorLangId = editor.document.languageId;
      const editorFilePath = editor.document.fileName;
			const editorWorkspace = workspace.getWorkspaceFolder(editor.document.uri);
			if (!editorWorkspace) {
				// log that no workspace was found for file
				const message = `No workspace found for file: ${editorFilePath}`;
				outputLogChannel.appendLine(message);
				return;
			}

      const matchers = buildMatchers(
        langConfig[editorLangId] || langConfig['html']
      );

      const tailwindConfig = getTailwindConfig({
        filepath: editorFilePath,
				tailwindConfig: tailwindConfigPath
      });

      if (!tailwindConfig) {
        if (!IgnoreConfigNotFound) {
          window.showErrorMessage(
            'Tailwind Raw Reorder: Tailwind config not found'
          );
        }
        return;
      }

      for (const matcher of matchers) {
        getTextMatch(matcher.regex, editorText, (text, startPosition) => {
          const endPosition = startPosition + text.length;
          const range = new Range(
            editor.document.positionAt(startPosition),
            editor.document.positionAt(endPosition)
          );

          const options = {
            separator: matcher.separator,
            replacement: matcher.replacement,
            env: tailwindConfig
          };

          const sortedText = sortClasses(text, options);

          edit.replace(range, sortedText);

          let movedClasses = findMovedClasses(text, sortedText)
          highlightMovedClasses(startPosition, editor, movedClasses);

          // Listen for document changes to clear decorations on undo
          if (movedClasses.length === activeDecorationTypes.length) {
            const documentChangeListener = workspace.onDidChangeTextDocument((event) => {
              const editor = window.activeTextEditor;
              // Ignore changes in other documents
              if (!editor || event.document !== editor.document) {
                return;
              }
          
              const currentText = editor.document.getText();
              const originalText = editorText;
          
              if (currentText === originalText && activeDecorationTypes) {
                clearDecorations();
                documentChangeListener.dispose();
              }
            });

            context.subscriptions.push(documentChangeListener);

            // Clear the decorations after 7 seconds
            setTimeout(() => {
              clearDecorations();
              documentChangeListener.dispose(); // Dispose of the listener after use
            }, currentHighlightTimeout);

          }
        });
      }
    }
  );

  let runOnProject = commands.registerCommand(
    'tailwind-raw-reorder.sortTailwindClassesOnWorkspace',
    () => {
      let workspaceFolder = workspace.workspaceFolders || [];
      if (workspaceFolder[0]) {
        window.showInformationMessage(
          `Running Tailwind Raw Reorder on: ${workspaceFolder[0].uri.fsPath}`
        );

        let rustyWindArgs = [
          workspaceFolder[0].uri.fsPath,
          '--write',
        ].filter((arg) => arg !== '');

        let rustyWindProc = spawn(rustyWindPath, rustyWindArgs);

        rustyWindProc.stdout.on(
          'data',
          (data) =>
            data &&
            data.toString() !== '' &&
            console.log('rustywind stdout:\n', data.toString())
        );

        rustyWindProc.stderr.on('data', (data) => {
          if (data && data.toString() !== '') {
            console.log('rustywind stderr:\n', data.toString());
            window.showErrorMessage(`Tailwind Raw Reorder error: ${data.toString()}`);
          }
        });
      }
    }
  );

  let runOnSelection = commands.registerCommand(
    'tailwind-raw-reorder.sortTailwindClassesOnSelection',
    () => {
      let editor = window.activeTextEditor;
      if (editor) {
        let selection = editor.selection;
        let editorText = editor.document.getText(selection);
        let editorLangId = editor.document.languageId;
        let editorFilePath = editor.document.fileName;

        const matchers = buildMatchers(
          langConfig[editorLangId] || langConfig['html']
        );

        const tailwindConfig = getTailwindConfig({
          filepath: editorFilePath,
					tailwindConfig: tailwindConfigPath
        });

        if (!tailwindConfig) {
          if (!IgnoreConfigNotFound) {
            window.showErrorMessage(
              'Tailwind Raw Reorder: Tailwind config not found'
            );
          };
          return;
        }

        for (const matcher of matchers) {
          const seperator = matcher.separator;
          const replacement = matcher.replacement;

          //regex that matches a seperator seperated list of classes that may contain letters, numbers, dashes, underscores, square brackets, square brackets with single quotes inside, and forward slashes
          const regexContent = `(?:[a-zA-Z][a-zA-Z\\/_\\-:]+(?:\\[[a-zA-Z\\/_\\-"'\\\\:\\.]\\])?(${(seperator || /\s/).source})*)+`;
          const regex = new RegExp(regexContent);
          if (regex.test(editorText)) {
            const sortedText = sortClasses(editorText, {
              seperator: seperator,
              replacement,
              env: tailwindConfig
            });
            editor.edit((editBuilder) => {
              editBuilder.replace(selection, sortedText);
            });
          }
        }
      }
    }
  );

  context.subscriptions.push(runOnProject);
  context.subscriptions.push(disposable);

  // if runOnSave is enabled organize tailwind classes before saving
  if (config.get('tailwind-raw-reorder.runOnSave')) {
    context.subscriptions.push(
      workspace.onWillSaveTextDocument((_e) => {
        commands.executeCommand('tailwind-raw-reorder.sortTailwindClasses');
      })
    );
  }
}

/**
 * @param {string} str1
 * @param {string} str2
 */
function findMovedClasses(str1, str2) {
  if(!str1 || !str2) {
    console.log("One of the strings is empty");
    return [];
  }
  const classes1 = str1.split(/\s+/);
  const classes2 = str2.split(/\s+/);

  // Find longest common subsequence (LCS)
  /**
   * @param {string | any[]} arr1
   * @param {string | any[]} arr2
  */
  function lcs(arr1, arr2) {
      let dp = Array(arr1.length + 1).fill(null).map(() => Array(arr2.length + 1).fill(0));

      for (let i = 1; i <= arr1.length; i++) {
          for (let j = 1; j <= arr2.length; j++) {
              if (arr1[i - 1] === arr2[j - 1]) {
                  dp[i][j] = dp[i - 1][j - 1] + 1;
              } else {
                  dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
              }
          }
      }

      let i = arr1.length, j = arr2.length, lcsArr = [];
      while (i > 0 && j > 0) {
          if (arr1[i - 1] === arr2[j - 1]) {
              lcsArr.unshift(arr1[i - 1]);
              i--; j--;
          } else if (dp[i - 1][j] >= dp[i][j - 1]) {
              i--;
          } else {
              j--;
          }
      }
      return new Set(lcsArr);
  }

  const commonClasses = lcs(classes1, classes2);

  /**
   * @param {string} str
   * @param {Set<any>} commonSet
   */
  function filterCommonClasses(str, commonSet) {
      let classes = str.split(/\s+/);
      let index = 0;
      let seen = new Map();

      return classes
          .map(className => {
              let startIndex = str.indexOf(className, seen.get(className) || index);
              seen.set(className, startIndex + className.length); // Track last occurrence
              return { className, charStart: startIndex };
          })
          .filter(({ className }) => !commonSet.has(className)); // Only return classes not in LCS
  }

  return filterCommonClasses(str2, commonClasses); // Only return moved classes in str2
}

/**
 * @param {any} startPosition
 * @param {{ document: { positionAt: (arg0: any) => any; }; setDecorations: (arg0: import("vscode").TextEditorDecorationType, arg1: Range[]) => void; }} editor
 * @param {any[]} classes
 */
function highlightMovedClasses(startPosition, editor, classes) {
  if(!classes || classes.length === 0) {
    return;
  }
  
  let decorationTypes = [];

  // Collect all ranges for the changed classes
  // range = start and end character indexes
  /**
   * @typedef {{ className: string; charStart: number; }} ClassObject
   * @typedef {import("vscode").TextEditorDecorationType} TextEditorDecorationType
   * @typedef {import("vscode").Range} Range
   */
  const ranges = classes
    .filter((classObj) => classObj.charStart !== -1) // Ensure the classes exists in str2
    .map((classObj) => {
      const startPos = editor.document.positionAt(startPosition + classObj.charStart);
      const endPos = editor.document.positionAt(startPosition + classObj.charStart + classObj.className.length);
      console.log("Start position:", startPos, "End position:", endPos);
      const range = new Range(startPos, endPos);
      const decorationType = window.createTextEditorDecorationType({
        color: new ThemeColor(currentHighlightColor), // Set the desired background color for moved classes
      });
      if (startPos && endPos && range) {
        editor.setDecorations(decorationType, [range]);
        activeDecorationTypes.push(decorationType);
      }
    });
}

function clearDecorations() {
  for (const decorationType of activeDecorationTypes) {
    decorationType.dispose();
  }
  activeDecorationTypes = [];
}