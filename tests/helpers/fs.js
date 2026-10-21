// In-memory реализация File System Access API (FileSystemDirectoryHandle / FileSystemFileHandle)
// в объёме, который использует lib/folder.js.

function domError(name, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const toBytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));

export class MemFile {
  kind = 'file';
  constructor(name) {
    this.name = name;
    this.bytes = new Uint8Array();
    this.writes = 0;
  }
  async getFile() {
    const bytes = this.bytes;
    return { name: this.name, size: bytes.length, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer };
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (data) => chunks.push(toBytes(data)),
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        this.bytes = out;
        this.writes++;
      },
    };
  }
  text() {
    return new TextDecoder().decode(this.bytes);
  }
}

export class MemDir {
  kind = 'directory';
  constructor(name, { permission = 'granted', grantOnRequest = true } = {}) {
    this.name = name;
    this.children = new Map();
    this.permission = permission;
    this.grantOnRequest = grantOnRequest;
    this.failWrites = null; // строка — текст ошибки при создании файлов
  }
  async queryPermission() {
    return this.permission;
  }
  async requestPermission() {
    if (this.permission === 'prompt' && this.grantOnRequest) this.permission = 'granted';
    return this.permission;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw domError('TypeMismatchError');
      return existing;
    }
    if (!create) throw domError('NotFoundError', `Каталог «${name}» не найден`);
    const dir = new MemDir(name);
    dir.failWrites = this.failWrites;
    this.children.set(name, dir);
    return dir;
  }
  async getFileHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw domError('TypeMismatchError');
      return existing;
    }
    if (!create) throw domError('NotFoundError', `Файл «${name}» не найден`);
    if (this.failWrites) throw domError('NoModificationAllowedError', this.failWrites);
    const file = new MemFile(name);
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name, { recursive = false } = {}) {
    const entry = this.children.get(name);
    if (!entry) throw domError('NotFoundError');
    if (entry.kind === 'directory' && entry.children.size && !recursive) throw domError('InvalidModificationError');
    this.children.delete(name);
  }
  async *entries() {
    for (const [name, handle] of [...this.children]) yield [name, handle];
  }
  // --- удобства для тестов ---
  has(path) {
    return !!this.at(path);
  }
  at(path) {
    let node = this;
    for (const part of path.split('/').filter(Boolean)) {
      node = node?.kind === 'directory' ? node.children.get(part) : undefined;
    }
    return node;
  }
  list(path = '') {
    const node = path ? this.at(path) : this;
    return node ? [...node.children.keys()].sort() : [];
  }
  put(path, content = '') {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    let node = this;
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, new MemDir(part));
      node = node.children.get(part);
    }
    const f = new MemFile(fileName);
    f.bytes = toBytes(content);
    node.children.set(fileName, f);
    return f;
  }
}
