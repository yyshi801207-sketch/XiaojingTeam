/** Generate application, installer and platform icons from the approved original artwork. */
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runIconsTool } from 'app-builder-lib/out/toolsets/icons.js'

const buildRoot = fileURLToPath(new URL('../build/', import.meta.url))
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^PSModulePath$/i.test(key)))
for (const script of ['prepare-windows-icon.ps1', 'prepare-installer-logo.ps1']) {
  await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL(script, import.meta.url))], { env, windowsHide: true })
}
const output = await mkdtemp(join(tmpdir(), 'xiaojing-installer-icon-'))
try {
  for (const format of ['ico', 'icns']) {
    await runIconsTool({ inputFile: join(buildRoot, 'app-icon.png'), outputFormat: format, outDir: output })
    const target = join(buildRoot, format === 'ico' ? 'installer-runtime-icon.ico' : 'app-icon.icns')
    const generated = await readFile(join(output, `icon.${format}`))
    let current
    try {
      current = await readFile(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (!current?.equals(generated)) {
      const staged = `${target}.${String(process.pid)}.tmp`
      try {
        await writeFile(staged, generated)
        for (let attempt = 1; ; attempt += 1) {
          try {
            await copyFile(staged, target)
            break
          } catch (error) {
            if (!['UNKNOWN', 'EBUSY', 'EPERM'].includes(error?.code) || attempt === 10) throw error
            await delay(attempt * 100)
          }
        }
      } finally {
        await rm(staged, { force: true })
      }
    }
  }
} finally {
  await rm(output, { recursive: true, force: true })
}
