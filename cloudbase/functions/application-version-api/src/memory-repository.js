"use strict";

const { ApiError } = require("./errors");

function createMemoryRepository() {
  const stores = new Map();

  function appStore(appId) {
    if (!stores.has(appId)) {
      stores.set(appId, { versions: new Map(), ads: new Map(), audit: [] });
    }
    return stores.get(appId);
  }

  return {
    async createVersion(appId, record, audit) {
      const store = appStore(appId);
      assertVersionKeyAvailable(store, record.code, record.versionKey);
      if (store.versions.has(record.id)) throw conflict();
      store.versions.set(record.id, structuredClone(record));
      store.audit.push(structuredClone(audit));
    },

    async updateVersion(appId, id, record, audit, authorizedCodes) {
      const store = appStore(appId);
      const existing = store.versions.get(id);
      if (!existing) return null;
      assertCodeAuthorized(authorizedCodes, existing.code);
      assertCodeAuthorized(authorizedCodes, record.code);
      assertVersionKeyAvailable(store, record.code, record.versionKey, id);
      const updated = {
        ...structuredClone(record),
        id,
        createdAt: existing.createdAt,
      };
      store.versions.set(id, updated);
      store.audit.push(structuredClone(audit));
      return structuredClone(updated);
    },

    async listVersions(appId, codes, pagination) {
      const allowed = new Set(codes);
      const values = [...appStore(appId).versions.values()]
        .filter(({ code }) => allowed.has(code))
        .sort(compareCreated(pagination.direction));
      return paginate(values, pagination);
    },

    async listVersionsForCode(appId, code) {
      return [...appStore(appId).versions.values()]
        .filter((record) => record.code === code)
        .map((record) => structuredClone(record));
    },

    async createAd(appId, record, audit) {
      const store = appStore(appId);
      if (store.ads.has(record.id)) throw conflict();
      store.ads.set(record.id, structuredClone(record));
      store.audit.push(structuredClone(audit));
    },

    async updateAd(appId, code, id, changes, audit) {
      const store = appStore(appId);
      const existing = store.ads.get(id);
      if (!existing || existing.appCode !== code) return null;
      const updated = {
        ...existing,
        ...structuredClone(changes),
        id,
        appCode: code,
      };
      store.ads.set(id, updated);
      store.audit.push(structuredClone(audit));
      return structuredClone(updated);
    },

    async deleteAd(appId, code, id, audit) {
      const store = appStore(appId);
      const existing = store.ads.get(id);
      if (!existing || existing.appCode !== code) return null;
      store.ads.delete(id);
      store.audit.push(structuredClone(audit));
      return structuredClone(existing);
    },

    async getAd(appId, id) {
      const value = appStore(appId).ads.get(id);
      return value ? structuredClone(value) : null;
    },

    async listAds(appId, code, pagination) {
      const values = [...appStore(appId).ads.values()]
        .filter((record) => record.appCode === code)
        .sort(compareCreated(pagination.direction));
      return paginate(values, pagination);
    },

    async showAds(appId, code) {
      return [...appStore(appId).ads.values()]
        .filter((record) => record.appCode === code)
        .sort(compareCreated("desc"))
        .slice(0, 100)
        .map((record) => structuredClone(record));
    },

    snapshot(appId) {
      const store = appStore(appId);
      return {
        versions: [...store.versions.values()].map((record) =>
          structuredClone(record),
        ),
        ads: [...store.ads.values()].map((record) => structuredClone(record)),
        audit: store.audit.map((record) => structuredClone(record)),
      };
    },
  };
}

function assertVersionKeyAvailable(store, code, versionKey, excludedId) {
  if (
    [...store.versions.values()].some(
      (record) =>
        record.id !== excludedId &&
        record.code === code &&
        record.versionKey === versionKey,
    )
  ) {
    throw conflict();
  }
}

function conflict() {
  return new ApiError(409, "resource.conflict", "资源已存在或发生冲突");
}

function assertCodeAuthorized(authorizedCodes, code) {
  if (!(authorizedCodes instanceof Set) || !authorizedCodes.has(code)) {
    throw new ApiError(403, "auth.forbidden", "没有访问权限");
  }
}

function paginate(values, { page, size }) {
  const totalRecords = values.length;
  const start = (page - 1) * size;
  return {
    records: values
      .slice(start, start + size)
      .map((record) => structuredClone(record)),
    totalRecords,
  };
}

function compareCreated(direction) {
  const multiplier = direction === "asc" ? 1 : -1;
  return (left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -multiplier : multiplier;
    }
    if (left.id === right.id) return 0;
    return left.id < right.id ? -multiplier : multiplier;
  };
}

module.exports = { createMemoryRepository };
