// Bounded, side-effect-free validation for prepared v86 AOT indexes.
//
// This module deliberately stops before aot_buffer_alloc/aot_buffer_commit.  A
// caller must pass the returned package to the existing loader only after this
// function reports `validated`; all other outcomes are ordinary-JIT fallback.

const MAX_ARTIFACT_BYTES = 96 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_UNITS = 2048;
const MAX_UNIT_BYTES = 1024 * 1024;
const MAX_PAGES = 64;
const MAX_MAPPINGS = 128;
const MAX_ENTRIES = 16384;
const MAX_RELOCATIONS = 16384;
const CONFIG_COUNT = 22;
const FASTMEM_READS_CONFIG_INDEX = 9;
const FASTMEM_WRITES_CONFIG_INDEX = 19;
const HEADER_WORDS = 33;
const MAGIC = 0x31544f41;
const SHA256 = /^[a-f0-9]{64}$/i;
const PGO_MANIFEST_VERSIONS = new Set([1, 2]);

const skip = (reason, detail = undefined) => ({
  status: 'skipped',
  reason,
  ...(detail === undefined ? {} : { detail }),
});

function word(view, offset) {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error('truncated AOT word');
  return view.getUint32(offset, true);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('archive reader returned non-byte data');
}

function hashText(value) {
  return typeof value === 'string' && SHA256.test(value) ? value.toLowerCase() : null;
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function relativePath(manifestPath, child) {
  if (typeof child !== 'string' || child.length === 0 || child.startsWith('/'))
    throw new Error('invalid archive path');
  const base = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1);
  const parts = `${base}${child}`.split('/');
  const result = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('archive path escapes its directory');
    result.push(part);
  }
  return result.join('/');
}

function json(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function validateJitConfig(value) {
  if (!Array.isArray(value) || value.length !== CONFIG_COUNT) return null;
  if (!value.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 0xffffffff))
    return null;
  return value.map((entry) => entry >>> 0);
}

function profileFastmemError(mapping, jitConfig, reason) {
  if (
    mapping === 'profile' &&
    (jitConfig[FASTMEM_READS_CONFIG_INDEX] !== 0 || jitConfig[FASTMEM_WRITES_CONFIG_INDEX] !== 0)
  ) return reason;
  return null;
}

function validateInstalled(installed) {
  if (!installed || !Number.isSafeInteger(installed.memoryBytes) || installed.memoryBytes <= 0)
    return 'runtime-context-unavailable';
  if (!hashText(installed.wasmSha256) || !hashText(installed.javascriptSha256))
    return 'runtime-identity-unavailable';
  for (const field of ['cpuMode', 'paging', 'mapping']) {
    if (installed[field] !== undefined && typeof installed[field] !== 'string')
      return 'runtime-address-space-unavailable';
  }
  if (!validateJitConfig(installed.jitConfig)) return 'runtime-config-unavailable';
  return null;
}

function cpuExports(cpu) {
  return cpu?.wm?.exports ?? cpu?.v86?.cpu?.wm?.exports ?? cpu?.v86?.wm?.exports ?? null;
}

function validateCpuContext(cpu, installed) {
  const exports = cpuExports(cpu);
  if (typeof exports?.get_jit_config !== 'function') return 'runtime-config-unavailable';
  const actual = [];
  for (let index = 0; index < CONFIG_COUNT; index++) {
    let value;
    try {
      value = exports.get_jit_config(index);
    } catch {
      return 'runtime-config-unavailable';
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
      return 'runtime-config-unavailable';
    actual.push(value >>> 0);
  }
  if (actual.some((value, index) => value !== installed.jitConfig[index]))
    return 'runtime-config-mismatch';
  const cpuMemory = cpuMemoryBytes(cpu?.memory_size ?? cpu?.memorySize ?? cpu?.v86?.cpu?.memory_size);
  if (cpuMemory !== undefined && cpuMemory !== installed.memoryBytes)
    return 'runtime-memory-mismatch';
  return null;
}

function cpuMemoryBytes(value) {
  if (Number.isSafeInteger(value)) return value;
  if (ArrayBuffer.isView(value) && value.length === 1 && Number.isSafeInteger(value[0])) return value[0];
  return undefined;
}

function validatePackage(bytes) {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_ARTIFACT_BYTES)
    throw new Error('artifact exceeds byte budget');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (word(view, 0) !== MAGIC) throw new Error('invalid AOT magic');
  const count = word(view, 4);
  if (count < 1 || count > MAX_UNITS) throw new Error('invalid AOT unit count');
  let offset = 8;
  const units = [];
  for (let unitIndex = 0; unitIndex < count; unitIndex++) {
    const length = word(view, offset);
    offset += 4;
    if (length < HEADER_WORDS * 4 || length > MAX_UNIT_BYTES || offset + length > bytes.byteLength)
      throw new Error(`invalid AOT unit ${unitIndex}`);
    const unit = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
    const pages = word(unit, 120);
    const mappings = word(unit, 124);
    const entries = word(unit, 128);
    if (!pages || pages > MAX_PAGES || !mappings || mappings > MAX_MAPPINGS || !entries || entries > MAX_ENTRIES)
      throw new Error(`invalid AOT tables ${unitIndex}`);
    const memoryBytes = word(unit, 16);
    if (memoryBytes < 4096) throw new Error(`invalid AOT memory size ${unitIndex}`);
    const pageStart = HEADER_WORDS * 4;
    const mapStart = pageStart + pages * 4100;
    const entryStart = mapStart + mappings * 8;
    const relocationStart = entryStart + entries * 8;
    if (relocationStart + 4 > length) throw new Error(`truncated AOT tables ${unitIndex}`);
    const pageSet = new Set();
    for (let i = 0; i < pages; i++) {
      const at = pageStart + i * 4100;
      const address = word(unit, at);
      if (
        address < 0x100000 ||
        (address & 0xfff) !== 0 ||
        address > memoryBytes - 4096 ||
        pageSet.has(address)
      ) throw new Error(`invalid AOT physical page ${unitIndex}`);
      pageSet.add(address);
    }
    if (!pageSet.has((word(unit, 0) & 0xfffff000) >>> 0)) throw new Error(`AOT root page missing ${unitIndex}`);
    const mappingSet = new Set();
    const virtualMappingSet = new Set();
    for (let i = 0; i < mappings; i++) {
      const at = mapStart + i * 8;
      const virtualAddress = word(unit, at);
      const physicalAddress = word(unit, at + 4);
      if (
        (virtualAddress & 0xfff) !== 0 ||
        !pageSet.has(physicalAddress) ||
        virtualMappingSet.has(virtualAddress)
      ) throw new Error(`invalid AOT mapping ${unitIndex}`);
      mappingSet.add(physicalAddress);
      virtualMappingSet.add(virtualAddress);
    }
    if (mappingSet.size !== pageSet.size) throw new Error(`incomplete AOT mappings ${unitIndex}`);
    const entrySet = new Set();
    for (let i = 0; i < entries; i++) {
      const at = entryStart + i * 8;
      const address = word(unit, at);
      const state = word(unit, at + 4);
      if (!pageSet.has((address & 0xfffff000) >>> 0) || state >= 0xffff || entrySet.has(address))
        throw new Error(`invalid AOT entry ${unitIndex}`);
      entrySet.add(address);
    }
    const relocationCount = word(unit, relocationStart);
    if (relocationCount > MAX_RELOCATIONS) throw new Error(`invalid AOT relocations ${unitIndex}`);
    const wasmStart = relocationStart + 4 + relocationCount * 4;
    if (wasmStart + 8 > length) throw new Error(`truncated AOT Wasm ${unitIndex}`);
    for (let i = 0; i < relocationCount; i++) {
      const at = word(unit, relocationStart + 4 + i * 4);
      if (
        at === 0 ||
        at + 3 > length - wasmStart ||
        unit.getUint8(wasmStart + at - 1) !== 0x41 ||
        (unit.getUint8(wasmStart + at) & 0x80) === 0 ||
        (unit.getUint8(wasmStart + at + 1) & 0x80) === 0 ||
        (unit.getUint8(wasmStart + at + 2) & 0x80) !== 0
      )
        throw new Error(`invalid AOT relocation ${unitIndex}`);
    }
    const wasm = new Uint8Array(bytes.buffer, bytes.byteOffset + offset + wasmStart, length - wasmStart);
    if (!WebAssembly.validate(wasm)) throw new Error(`invalid AOT Wasm ${unitIndex}`);
    const jitConfig = [];
    for (let i = 0; i < CONFIG_COUNT; i++) jitConfig.push(word(unit, (8 + i) * 4));
    units.push({ memoryBytes, jitConfig });
    offset += length;
  }
  if (offset !== bytes.byteLength) throw new Error('trailing AOT bytes');
  return { count, units };
}

async function readBounded(archive, path, limit) {
  if (!archive || typeof archive.read !== 'function') throw new Error('archive reader unavailable');
  const bytes = asBytes(await archive.read(path, limit));
  if (bytes.byteLength > limit) throw new Error('archive read exceeds byte budget');
  return bytes;
}

function descriptorContext(index, manifest) {
  const external = index.context ?? {};
  const runtime = manifest.runtime ?? {};
  const wasmSha256 = hashText(
    external.runtimeWasmSha256 ?? manifest.runtimeWasmSha256 ?? runtime.wasmSha256 ?? manifest.abi,
  );
  const javascriptSha256 = hashText(
    external.runtimeJavascriptSha256 ?? manifest.runtimeJavascriptSha256 ?? runtime.javascriptSha256,
  );
  const memoryBytes = external.memoryBytes ?? manifest.memoryBytes ?? runtime.memoryBytes;
  const recipe = external.recipe ?? manifest.recipe ?? runtime.recipe;
  const cpuMode = external.cpuMode ?? manifest.cpuMode ?? runtime.cpuMode;
  const paging = external.paging ?? manifest.paging ?? runtime.paging;
  const mapping = external.mapping ?? manifest.mapping ?? runtime.mapping;
  const overrides = external.jitConfigOverrides ?? manifest.jitConfigOverrides ?? [];
  if (!wasmSha256 || !javascriptSha256 || !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0)
    return null;
  if (!Array.isArray(overrides) || overrides.some((pair) =>
    !Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) ||
    !Number.isSafeInteger(pair[1]) || pair[0] < 0 || pair[0] >= CONFIG_COUNT || pair[1] < 0 || pair[1] > 0xffffffff
  )) return null;
  return { wasmSha256, javascriptSha256, memoryBytes, recipe, cpuMode, paging, mapping, overrides };
}

function checkDescriptorContext(context, installed) {
  if (!context) return 'artifact-context-unavailable';
  if (context.wasmSha256 !== installed.wasmSha256) return 'runtime-wasm-mismatch';
  if (context.javascriptSha256 !== installed.javascriptSha256) return 'runtime-javascript-mismatch';
  if (context.memoryBytes !== installed.memoryBytes) return 'runtime-memory-mismatch';
  if (context.cpuMode !== undefined && context.cpuMode !== installed.cpuMode)
    return 'runtime-cpu-mode-mismatch';
  if (context.paging !== undefined && context.paging !== installed.paging)
    return 'runtime-paging-mismatch';
  if (context.mapping !== undefined && context.mapping !== installed.mapping)
    return 'runtime-mapping-mismatch';
  if (context.recipe !== undefined && installed.recipe !== undefined && context.recipe !== installed.recipe)
    return 'runtime-recipe-mismatch';
  return null;
}

function hasRuntimeAddressSpaceIdentity(installed) {
  return installed.cpuMode !== undefined || installed.paging !== undefined || installed.mapping !== undefined;
}

function moduleGuardError(guard, moduleHash, installed) {
  if (!guard || typeof guard !== 'object' || Array.isArray(guard))
    return 'artifact-module-guard-unavailable';
  if (hashText(guard.sourceHash) !== moduleHash) return 'artifact-module-source-mismatch';
  if (guard.cpuMode !== installed.cpuMode) return 'runtime-cpu-mode-mismatch';
  if (guard.paging !== installed.paging) return 'runtime-paging-mismatch';
  if (guard.mapping !== installed.mapping) return 'runtime-mapping-mismatch';
  if (!Number.isSafeInteger(guard.loadBase) || !Number.isSafeInteger(guard.imageSize) || guard.imageSize <= 0)
    return 'artifact-module-layout-unavailable';
  const paged = guard.paging === 'enabled';
  const limit = paged ? 0x1_0000_0000 : installed.memoryBytes;
  if (guard.loadBase % 4096 !== 0 || guard.loadBase < (paged ? 0 : 0x100000) ||
      guard.loadBase + guard.imageSize > limit)
    return 'artifact-module-layout-mismatch';
  return null;
}

function validateModuleGuards(index, manifest, descriptors, installed) {
  if (!hasRuntimeAddressSpaceIdentity(installed)) return null;
  const records = new Map();
  if (Array.isArray(manifest.modules)) {
    for (const module of manifest.modules) {
      const hash = hashText(module?.sourceHash);
      if (hash) records.set(hash, module?.compilation?.moduleGuard);
    }
  }
  if (Array.isArray(manifest.artifacts)) {
    for (const artifact of manifest.artifacts) {
      const hash = hashText(artifact?.moduleHash);
      if (hash) records.set(hash, artifact?.moduleGuard);
    }
  }
  for (const descriptor of descriptors) {
    if (!descriptor.moduleHash) {
      if (index.kind === 'static') return 'artifact-module-guard-unavailable';
      continue;
    }
    const error = moduleGuardError(records.get(descriptor.moduleHash), descriptor.moduleHash, installed);
    if (error) return error;
  }
  return null;
}

function packageBytes(parts) {
  let total = 8;
  let units = 0;
  for (const bytes of parts) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = word(view, 4);
    units += count;
    total += bytes.byteLength - 8;
  }
  if (units < 1 || units > MAX_UNITS || total > MAX_ARTIFACT_BYTES)
    throw new Error('merged AOT exceeds budget');
  const result = new Uint8Array(total);
  const output = new DataView(result.buffer);
  output.setUint32(0, MAGIC, true);
  output.setUint32(4, units, true);
  let offset = 8;
  for (const bytes of parts) {
    result.set(bytes.subarray(8), offset);
    offset += bytes.byteLength - 8;
  }
  return result;
}

/**
 * Validate an index and return a package ready for the existing AOT loader.
 * This function never calls a Wasm export and never installs or executes code.
 */
export async function preflightPreparedAot({ cpu, index, archive, installed, sourceBundleHash = undefined }) {
  const installedError = validateInstalled(installed);
  if (installedError) return skip(installedError);
  const cpuError = validateCpuContext(cpu, installed);
  if (cpuError) return skip(cpuError);
  if (!index || (index.kind !== 'static' && index.kind !== 'pgo' && index.kind !== 'translation-index') || typeof index.manifestPath !== 'string')
    return skip('invalid-index');
  try {
    const manifest = json(await readBounded(archive, index.manifestPath, MAX_MANIFEST_BYTES));
    if (index.kind === 'static' &&
        (manifest.format !== 'gamebox-v86-aot-1' || typeof manifest.file !== 'string'))
      return skip('invalid-static-manifest');
    const translationIndex = Array.isArray(manifest.modules);
    if (index.kind === 'pgo' &&
        (!PGO_MANIFEST_VERSIONS.has(manifest.version) ||
         (!Array.isArray(manifest.artifacts) && !translationIndex)))
      return skip('invalid-pgo-manifest');
    if (index.kind === 'translation-index' &&
        (manifest.version !== 1 || (!Array.isArray(manifest.artifacts) && !translationIndex)))
      return skip('invalid-pgo-manifest');
    const context = descriptorContext(index, manifest);
    const contextError = checkDescriptorContext(context, installed);
    if (contextError) return skip(contextError);
    if (sourceBundleHash !== undefined &&
        ((index.kind === 'pgo' && manifest.sourceBundleHash !== sourceBundleHash) ||
         (index.kind !== 'pgo' && manifest.sourceBundleHash !== undefined && manifest.sourceBundleHash !== sourceBundleHash)))
      return skip('source-bundle-mismatch');

    let descriptors;
    if (index.kind === 'static') {
      descriptors = [{ path: index.artifactPath ?? relativePath(index.manifestPath, manifest.file), bytes: manifest.bytes, sha256: manifest.sha256 }];
    } else if (translationIndex) {
      if (manifest.modules.length > MAX_UNITS) return skip('artifact-budget-exceeded');
      const root = index.artifactRoot === undefined
        ? null
        : String(index.artifactRoot).replace(/\/+$/, '');
      const externalArtifacts = index.artifacts;
      if (externalArtifacts !== undefined && (!Array.isArray(externalArtifacts) || externalArtifacts.length > MAX_UNITS))
        return skip('artifact-budget-exceeded');
      if (Array.isArray(externalArtifacts)) {
        const modules = new Set(manifest.modules.map((module) => hashText(module?.sourceHash)).filter(Boolean));
        descriptors = externalArtifacts.map((artifact) => {
          const sourceHash = hashText(artifact.moduleHash);
          if (!sourceHash || !modules.has(sourceHash)) throw new Error('artifact source is absent from translation index');
          return {
            moduleHash: sourceHash,
            path: artifact.path ?? (root ? `${root}/${sourceHash}.aot` : relativePath(index.manifestPath, `${sourceHash}.aot`)),
            bytes: artifact.bytes,
            sha256: artifact.sha256,
          };
        });
      } else {
        descriptors = [];
        for (const module of manifest.modules) {
          const compilation = module?.compilation;
          if (!compilation || !Number.isSafeInteger(compilation.summary?.units) || compilation.summary.units <= 0)
            continue;
          const sourceHash = hashText(module.sourceHash);
          if (!sourceHash) return skip('invalid-artifact-index');
          descriptors.push({
            moduleHash: sourceHash,
            path: compilation.path ?? (root ? `${root}/${sourceHash}.aot` : relativePath(index.manifestPath, `${sourceHash}.aot`)),
            bytes: compilation.artifactBytes ?? compilation.bytes,
            sha256: compilation.artifactSha256 ?? compilation.sha256,
          });
        }
      }
      if (descriptors.length > MAX_UNITS) return skip('artifact-budget-exceeded');
    } else {
      const artifacts = index.artifacts ?? manifest.artifacts ?? [];
      if (!Array.isArray(artifacts) || artifacts.length > MAX_UNITS) return skip('artifact-budget-exceeded');
      descriptors = artifacts.map((artifact) => ({
        moduleHash: hashText(artifact.moduleHash),
        path: artifact.path ?? (typeof artifact.moduleHash === 'string' &&
          (index.artifactRoot
            ? `${String(index.artifactRoot).replace(/\/+$/, '')}/${artifact.moduleHash}.aot`
            : relativePath(index.manifestPath, `${artifact.moduleHash}.aot`))),
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      }));
    }
    if (descriptors.length === 0) return skip('no-artifacts');
    const moduleGuardErrorResult = validateModuleGuards(index, manifest, descriptors, installed);
    if (moduleGuardErrorResult) return skip(moduleGuardErrorResult);

    const parts = [];
    let unitCount = 0;
    let total = 0;
    for (const descriptor of descriptors) {
      if (typeof descriptor.path !== 'string') return skip('invalid-artifact-index');
      if (descriptor.bytes !== undefined &&
          (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 8 || descriptor.bytes > MAX_ARTIFACT_BYTES ||
           total + descriptor.bytes > MAX_ARTIFACT_BYTES))
        return skip('artifact-budget-exceeded');
      const remaining = MAX_ARTIFACT_BYTES - total;
      if (remaining < 8) return skip('artifact-budget-exceeded');
      const bytes = await readBounded(archive, descriptor.path, remaining);
      if (descriptor.bytes !== undefined && descriptor.bytes !== bytes.byteLength)
        return skip('artifact-size-mismatch');
      const expectedHash = descriptor.sha256 === undefined ? null : hashText(descriptor.sha256);
      if (descriptor.sha256 !== undefined && (!expectedHash || expectedHash !== await sha256(bytes)))
        return skip('artifact-checksum-mismatch');
      const parsed = validatePackage(bytes);
      for (const unit of parsed.units) {
        if (unit.memoryBytes !== installed.memoryBytes) return skip('artifact-memory-mismatch');
        const profileFastmemErrorResult = profileFastmemError(
          context.mapping ?? installed.mapping,
          unit.jitConfig,
          'artifact-profile-fastmem-mismatch',
        );
        if (profileFastmemErrorResult) return skip(profileFastmemErrorResult);
      }
      parts.push(bytes);
      unitCount += parsed.count;
      total += bytes.byteLength;
      if (unitCount > MAX_UNITS || total > MAX_ARTIFACT_BYTES) return skip('artifact-budget-exceeded');
    }
    const bytes = parts.length === 1 ? parts[0] : packageBytes(parts);
    return {
      status: 'validated',
      kind: index.kind,
      bytes,
      units: unitCount,
      artifactBytes: bytes.byteLength,
      sourceBundleHash: manifest.sourceBundleHash,
    };
  } catch (error) {
    return skip('invalid-artifact', error instanceof Error ? error.message : String(error));
  }
}

export const PREPARED_AOT_LIMITS = Object.freeze({
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxUnits: MAX_UNITS,
  maxUnitBytes: MAX_UNIT_BYTES,
});
