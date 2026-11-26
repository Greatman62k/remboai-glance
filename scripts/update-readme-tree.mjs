import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), '..')
const readmePath = resolve(repoRoot, 'README.md')
const startMarker = '<!-- PROJECT_TREE:START -->'
const endMarker = '<!-- PROJECT_TREE:END -->'
const visualExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.mp4', '.webm', '.mov',
])

const trackedPaths = execFileSync('git', ['ls-files', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

// Include this generator on its first run, before it has been staged.
const generatorPath = relative(repoRoot, scriptPath).split('\\').join('/')
if (!trackedPaths.includes(generatorPath)) trackedPaths.push(generatorPath)

const root = { name: 'remboai-glance', directories: new Map(), files: [], visualCount: 0 }

for (const path of [...new Set(trackedPaths)].sort()) {
  const parts = path.split('/')
  let node = root
  for (const part of parts.slice(0, -1)) {
    if (!node.directories.has(part)) {
      node.directories.set(part, { name: part, directories: new Map(), files: [], visualCount: 0 })
    }
    node = node.directories.get(part)
  }
  const name = parts.at(-1)
  const extension = name.includes('.') ? `.${name.split('.').at(-1).toLowerCase()}` : ''
  if (visualExtensions.has(extension)) node.visualCount += 1
  else node.files.push(name)
}

function childrenOf(node) {
  const compareNames = (left, right) => left < right ? -1 : left > right ? 1 : 0
  const directories = [...node.directories.values()]
    .sort((left, right) => compareNames(left.name, right.name))
    .map((child) => ({ name: `${child.name}/`, directory: child }))
  const files = node.files
    .sort(compareNames)
    .map((name) => ({ name }))
  if (node.visualCount) files.push({ name: `[${node.visualCount} visual assets]` })
  return [...directories, ...files]
}

function renderTree(node, prefix = '') {
  const children = childrenOf(node)
  return children.flatMap((child, index) => {
    const last = index === children.length - 1
    const line = `${prefix}${last ? '└── ' : '├── '}${child.name}`
    if (!child.directory) return [line]
    return [line, ...renderTree(child.directory, `${prefix}${last ? '    ' : '│   '}`)]
  })
}

const generatedBlock = `${startMarker}\n\`\`\`text\n${root.name}/\n${renderTree(root).join('\n')}\n\`\`\`\n${endMarker}`
const readme = readFileSync(readmePath, 'utf8')
const markerPattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'g')
const blocks = readme.match(markerPattern) ?? []
if (blocks.length !== 1) {
  throw new Error(`README must contain exactly one project-tree marker block; found ${blocks.length}.`)
}

if (process.argv.includes('--check')) {
  if (blocks[0] !== generatedBlock) {
    console.error('README project tree is stale. Run npm run docs:tree to refresh it.')
    process.exitCode = 1
  } else {
    console.log('README project tree is current.')
  }
} else {
  writeFileSync(readmePath, readme.replace(markerPattern, generatedBlock))
  console.log(`Updated README project tree from ${trackedPaths.length} Git-tracked paths.`)
}
