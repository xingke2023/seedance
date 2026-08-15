'use strict'

const store = new Map()
const providers = new Map()

module.exports = {
  get: (id) => store.get(id),
  set: (id, data) => store.set(id, data),
  size: () => store.size,
  setProvider: (id, provider) => providers.set(id, provider),
  getProvider: (id) => providers.get(id) || {},
}
