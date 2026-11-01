import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  LanguageVariant,
  createScanner,
  getTokenPosOfNode,
  isAsExpression,
  isNonNullExpression,
  isParameterDeclaration,
  isPropertyDeclaration,
  isTypeReferenceNode,
  isVariableDeclaration,
} from 'typescript/unstable/ast';
import { compile } from './build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot =
  path.resolve(root, 'src').replaceAll('\\', '/').toLowerCase() + '/';

export function checkTypes() {
  compile('tsconfig.json', false);
  compile('tsconfig.worker.json', false);
  const api = new API({ cwd: root });
  const failures = new Set();
  const inspected = new Set();
  try {
    const snapshot = api.updateSnapshot({
      openProjects: [
        path.join(root, 'tsconfig.json'),
        path.join(root, 'tsconfig.worker.json'),
      ],
    });
    for (const project of snapshot.getProjects()) {
      for (const filename of project.program.getSourceFileNames()) {
        const normalized = filename.replaceAll('\\', '/');
        if (
          !normalized.toLowerCase().startsWith(sourceRoot) ||
          normalized.includes('/vendor/')
        )
          continue;
        const file = project.program.getSourceFile(filename);
        if (!file) throw new Error('Compiler did not expose ' + filename);
        const relative = path.relative(root, filename);
        const literals = [];
        const fail = (node, reason) => {
          const line = file.text.slice(0, node.pos).split('\n').length;
          failures.add(relative + ':' + line + ': ' + reason);
        };
        function binding(name) {
          if (!name) return;
          if (name.elements) {
            for (const entry of name.elements)
              if (entry.name) binding(entry.name);
            return;
          }
          const type = project.checker.getTypeAtLocation(name);
          if (type && /\bany\b/.test(project.checker.typeToString(type)))
            fail(name, 'Inferred any type');
        }
        function visit(node) {
          if (node.kind === SyntaxKind.AnyKeyword)
            fail(node, 'Explicit any type');
          if (
            isNonNullExpression(node) ||
            (isPropertyDeclaration(node) && node.exclamationToken)
          )
            fail(node, 'Unchecked non-null or initialization assertion');
          if (node.kind === SyntaxKind.TypeAssertionExpression)
            fail(node, 'Unchecked type assertion');
          if (
            isAsExpression(node) &&
            file.text.slice(node.type.pos, node.type.end).trim() !== 'const'
          )
            fail(node, 'Unchecked type assertion');
          if (
            isTypeReferenceNode(node) &&
            /^(?:Object|Function)$/.test(
              file.text.slice(node.typeName.pos, node.typeName.end).trim(),
            )
          )
            fail(node, 'Unspecified object or function type');
          if (
            isVariableDeclaration(node) ||
            isParameterDeclaration(node) ||
            isPropertyDeclaration(node)
          )
            binding(node.name);
          if (
            [
              SyntaxKind.StringLiteral,
              SyntaxKind.RegularExpressionLiteral,
              SyntaxKind.NoSubstitutionTemplateLiteral,
              SyntaxKind.TemplateHead,
              SyntaxKind.TemplateMiddle,
              SyntaxKind.TemplateTail,
            ].includes(node.kind)
          )
            literals.push([getTokenPosOfNode(node, file), node.end]);
          node.forEachChild(visit);
        }
        visit(file);
        if (!inspected.has(filename)) {
          let cursor = 0,
            masked = '';
          for (const [start, end] of literals.sort(
            (left, right) => left[0] - right[0],
          )) {
            if (start < cursor) continue;
            masked +=
              file.text.slice(cursor, start) +
              file.text.slice(start, end).replace(/[^\r\n]/g, ' ');
            cursor = end;
          }
          masked += file.text.slice(cursor);
          const scanner = createScanner(
            false,
            LanguageVariant.Standard,
            masked,
          );
          for (
            let token = scanner.scan();
            token !== SyntaxKind.EndOfFile;
            token = scanner.scan()
          ) {
            if (
              token === SyntaxKind.SingleLineCommentTrivia ||
              token === SyntaxKind.MultiLineCommentTrivia
            )
              fail({ pos: scanner.getTokenStart() }, 'Authored source comment');
          }
          inspected.add(filename);
        }
      }
    }
  } finally {
    api.close();
  }
  if (failures.size) throw new Error([...failures].join('\n'));
  console.log(`TypeScript checks passed (${inspected.size} files).`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  checkTypes();
