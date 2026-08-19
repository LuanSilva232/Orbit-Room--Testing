import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const checkerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-server-boundaries.mjs'
)

test('resolves tsconfig path aliases in client boundary checks', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'server-boundary-check-')
  )

  try {
    fs.mkdirSync(path.join(fixtureRoot, 'src/server'), { recursive: true })
    fs.mkdirSync(path.join(fixtureRoot, 'src/components'), { recursive: true })
    fs.writeFileSync(
      path.join(fixtureRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@server/*': ['src/server/*'] },
        },
      })
    )
    fs.writeFileSync(
      path.join(fixtureRoot, 'src/server/auth.ts'),
      "import 'server-only'\nexport const secret = 'fixture'\n"
    )
    fs.writeFileSync(
      path.join(fixtureRoot, 'src/components/client.tsx'),
      "'use client'\nimport { secret } from '@server/auth'\nexport const Client = () => secret\n"
    )

    const result = spawnSync(process.execPath, [checkerPath], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.ok(
      (result.stdout + result.stderr).includes(
        path.join('src', 'server', 'auth.ts')
      )
    )
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('allows server-only modules in API Route Handlers', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'server-boundary-route-')
  )

  try {
    fs.mkdirSync(path.join(fixtureRoot, 'src/server'), { recursive: true })
    fs.mkdirSync(path.join(fixtureRoot, 'src/app/api/login'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(fixtureRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@server/*': ['src/server/*'] },
        },
      })
    )
    fs.writeFileSync(
      path.join(fixtureRoot, 'src/server/auth.ts'),
      "import 'server-only'\nexport const secret = 'fixture'\n"
    )
    fs.writeFileSync(
      path.join(fixtureRoot, 'src/app/api/login/route.ts'),
      "import { secret } from '@server/auth'\nexport function GET() { return Response.json({ secret }) }\n"
    )

    const result = spawnSync(process.execPath, [checkerPath], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0)
    assert.ok((result.stdout + result.stderr).includes('Server boundary check passed'))
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
