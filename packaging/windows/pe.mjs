// Small edits to a Windows executable (PE) that need no Windows SDK.
//
//   node pe.mjs unsign <exe>   remove the Authenticode signature
//   node pe.mjs gui <exe>      mark it a windowed (GUI) app, so no console opens
//
// node.exe is signed by the Node.js project. Changing it (icon, version info,
// the injected app) breaks that signature, and a broken signature looks worse
// to Windows than none, so it is removed first. Node runs fine as a GUI-subsystem
// program: the launcher and server log to a file and never use a console.
import { readFileSync, writeFileSync } from 'node:fs';

const [cmd, file] = process.argv.slice(2);
if (!file || !['unsign', 'gui'].includes(cmd)) {
  console.error('usage: node pe.mjs unsign|gui <exe>');
  process.exit(2);
}

let buf = readFileSync(file);
const pe = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${file} is not a PE executable`);
const opt = pe + 24; // optional header, after the 4-byte signature and 20-byte COFF header
const magic = buf.readUInt16LE(opt);
if (magic !== 0x10b && magic !== 0x20b) throw new Error(`Unknown optional header magic 0x${magic.toString(16)}`);
const CHECKSUM = opt + 64;
const SUBSYSTEM = opt + 68;
const dataDirs = opt + (magic === 0x20b ? 112 : 96);
const SECURITY = dataDirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY

if (cmd === 'unsign') {
  const at = buf.readUInt32LE(SECURITY);
  const size = buf.readUInt32LE(SECURITY + 4);
  if (size === 0) {
    console.log(`${file}: not signed`);
  } else {
    // The certificate table is a file offset (not an RVA) and sits at the end of the file.
    if (at + size < buf.length - 8) throw new Error('Signature is not at the end of the file; not removing it');
    buf = buf.subarray(0, at);
    buf.writeUInt32LE(0, SECURITY);
    buf.writeUInt32LE(0, SECURITY + 4);
    console.log(`${file}: removed ${size}-byte signature`);
  }
} else {
  const was = buf.readUInt16LE(SUBSYSTEM);
  buf.writeUInt16LE(2, SUBSYSTEM); // IMAGE_SUBSYSTEM_WINDOWS_GUI (console is 3)
  console.log(`${file}: subsystem ${was} -> 2 (GUI)`);
}
buf.writeUInt32LE(0, CHECKSUM); // only drivers and system DLLs are checked
writeFileSync(file, buf);
