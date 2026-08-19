import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const projectRoot = process.cwd()
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const ignoredDirectories = new Set([
  '.git',
  '.next',
  '.open-next',
  '.wrangler',
  'build',
  'dist',
  'node_modules',
  'out',
  'public',
])

function readPathAliases() {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json')
  if (!fs.existsSync(tsconfigPath)) return []

  const parsed = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (parsed.error) {
    const message = ts.flattenDiagnosticMessageText(
      parsed.error.messageText,
      '\n'
    )
    throw new Error(`Unable to read tsconfig.json: ${message}`)
  }

  const compilerOptions = parsed.config.compilerOptions ?? {}
  const baseUrl = path.resolve(
    projectRoot,
    compilerOptions.baseUrl ?? '.'
  )
  const paths = compilerOptions.paths ?? {}

  return Object.entries(paths).flatMap(([pattern, targets]) => {
    if (!Array.isArray(targets)) return []

    const wildcardIndex = pattern.indexOf('*')
    return [
      {
        prefix:
          wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex),
        suffix:
          wildcardIndex === -1 ? '' : pattern.slice(wildcardIndex + 1),
        hasWildcard: wildcardIndex !== -1,
        targets,
        baseUrl,
      },
    ]
  })
}

function walk(directory) {
  const files = []

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue

    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(entryPath))
      continue
    }

    if (sourceExtensions.has(path.extname(entry.name))) files.push(entryPath)
  }

  return files
}

function isClientEntry(source) {
  return /^\s*["']use client["']\s*;?/m.test(source)
}

function isServerOnlyModule(source) {
  return /^\s*import\s+["']server-only["']\s*;?/m.test(source)
}

function importsFrom(source) {
  const imports = []

  // Type-only imports are erased from the client bundle and are safe to use
  // for shared types. Runtime imports must still preserve the boundary.
  const staticImportPattern =
    /^\s*(import|export)\s+(type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/gm
  for (const match of source.matchAll(staticImportPattern)) {
    if (!match[2]) imports.push(match[3])
  }

  const sideEffectImportPattern = /^\s*import\s+["']([^"']+)["']/gm
  for (const match of source.matchAll(sideEffectImportPattern)) {
    imports.push(match[1])
  }

  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  for (const match of source.matchAll(dynamicImportPattern)) {
    imports.push(match[1])
  }

  return [...new Set(imports)]
}

function resolveImport(importer, specifier, knownFiles) {
  if (specifier.startsWith('.')) {
    return resolveFile(path.resolve(path.dirname(importer), specifier), knownFiles)
  }

  for (const alias of pathAliases) {
    const matchesAlias = alias.hasWildcard
      ? specifier.startsWith(alias.prefix) && specifier.endsWith(alias.suffix)
      : specifier === alias.prefix
    if (!matchesAlias) continue

    const wildcard = alias.hasWildcard
      ? specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length)
      : ''
    for (const target of alias.targets) {
      const targetPath = target.replace('*', wildcard)
      const resolved = resolveFile(
        path.resolve(alias.baseUrl, targetPath),
        knownFiles
      )
      if (resolved) return resolved
    }
  }

  return null
}

function resolveFile(candidate, knownFiles) {
  const possiblePaths = [candidate]
  for (const extension of sourceExtensions) {
    possiblePaths.push(`${candidate}${extension}`)
  }
  for (const extension of sourceExtensions) {
    possiblePaths.push(path.join(candidate, `index${extension}`))
  }

  for (const possiblePath of possiblePaths) {
    const absolutePath = path.normalize(possiblePath)
    if (knownFiles.has(absolutePath)) return absolutePath
  }

  return null
}

const pathAliases = readPathAliases()
const sourceFiles = walk(projectRoot)
const knownFiles = new Set(sourceFiles)
const sources = new Map(
  sourceFiles.map((filePath) => [filePath, fs.readFileSync(filePath, 'utf8')])
)
const serverOnlyFiles = new Set(
  sourceFiles.filter((filePath) => isServerOnlyModule(sources.get(filePath)))
)
const clientEntries = sourceFiles.filter((filePath) =>
  isClientEntry(sources.get(filePath))
)

const violations = []
const visited = new Set()

function visit(filePath, chain) {
  if (visited.has(filePath)) return
  visited.add(filePath)

  if (serverOnlyFiles.has(filePath)) {
    violations.push({ entry: chain[0], chain })
    return
  }

  for (const specifier of importsFrom(sources.get(filePath))) {
    const dependency = resolveImport(filePath, specifier, knownFiles)
    if (dependency) visit(dependency, [...chain, dependency])
  }
}

for (const clientEntry of clientEntries) visit(clientEntry, [clientEntry])

if (violations.length > 0) {
  console.error('Server/client boundary violations found:')
  for (const violation of violations) {
    console.error(`\nClient entry: ${path.relative(projectRoot, violation.entry)}`)
    for (const filePath of violation.chain) {
      console.error(`  -> ${path.relative(projectRoot, filePath)}`)
    }
  }
  console.error(
    '\nMove the server-only dependency behind an API Route Handler, or import shared types with `import type`.'
  )
  process.exitCode = 1
} else {
  console.log(
    `Server boundary check passed (${clientEntries.length} client entries, ${serverOnlyFiles.size} server-only modules).`
  )
}
