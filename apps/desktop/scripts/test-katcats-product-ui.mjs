/** Run the packaged product UI check without the dotenv-loading Web test lane. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { smokeKatcatsProduct } from './smoke-katcats-product.ts'
import { developmentEnvironment, prepareRun } from '../../../scripts/katcats-dev.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
if (process.argv[2] === undefined) throw new Error('Pass this checkout\'s unpacked application directory')
const application = resolve(process.argv[2])
const directory = await mkdtemp(join(root, 'run/tmp/katcats-packaged-ui-'))
const require = createRequire(import.meta.url)
const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar')
const resources = join(application, 'resources'), archive = join(resources, 'app.asar')
const descriptor = JSON.parse(asar.extractFile(archive, join('dsh', 'desktop-runtime.json')).toString('utf8'))
console.log(JSON.stringify({ directory, application }))
try {
  await smokeKatcatsProduct(join(archive, 'dsh'), join(application, 'XiaojingAccountingTeam.exe'), descriptor,
    developmentEnvironment(prepareRun(directory), {}), join(resources, 'runtime'), directory)
} catch (error) {
  const text = String(error.stack ?? error).replace(/([?&]token=)[^\s&"'<>]+/gu, '$1[synthetic-redacted]')
  await writeFile(join(directory, 'failure.txt'), text + '\n')
  console.error(text)
  process.exitCode = 1
}
