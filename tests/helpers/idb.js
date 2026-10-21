// Минимальный in-memory indexedDB: open / createObjectStore / transaction / get / put / delete.
// Значения хранятся по ссылке — так в тестах можно класть мок-дескрипторы папок с методами
// (настоящий браузер сериализует FileSystemDirectoryHandle сам).

export function createIndexedDB() {
  const databases = new Map(); // name -> Map(storeName -> Map)

  const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null });

  function makeDb(name) {
    const stores = databases.get(name);
    return {
      name,
      closed: false,
      createObjectStore(storeName) {
        stores.set(storeName, new Map());
      },
      transaction(storeName, mode = 'readonly') {
        const store = stores.get(storeName);
        if (!store) throw new Error(`NotFoundError: object store ${storeName}`);
        const tx = { mode, error: null, oncomplete: null, onerror: null };
        const pending = [];
        const op = (fn) => {
          const req = request();
          pending.push(() => (req.result = fn()));
          return req;
        };
        tx.objectStore = () => ({
          get: (key) => op(() => store.get(key)),
          put: (value, key) => {
            if (mode !== 'readwrite') throw new Error('ReadOnlyError');
            return op(() => (store.set(key, value), key));
          },
          delete: (key) => {
            if (mode !== 'readwrite') throw new Error('ReadOnlyError');
            return op(() => void store.delete(key));
          },
        });
        setTimeout(() => {
          for (const run of pending) run();
          tx.oncomplete?.();
        }, 0);
        return tx;
      },
      close() {
        this.closed = true;
      },
    };
  }

  return {
    databases,
    open(name) {
      const req = request();
      setTimeout(() => {
        const isNew = !databases.has(name);
        if (isNew) databases.set(name, new Map());
        req.result = makeDb(name);
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}
