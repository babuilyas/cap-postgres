const dependencies = {
  get Client () {
    const Client = require('./client/Client')
    Object.defineProperty(dependencies, 'Client', { value: Client })
    return Client
  },
  /*
  get options () {
    const options = require('./client/options')
    Object.defineProperty(dependencies, 'options', { value: options })
    return options
  },
  get serviceFunctions () {
    const { serviceFunctions } = require('@sap/cds-sql')
    Object.defineProperty(dependencies, 'serviceFunctions', { value: serviceFunctions })
    return serviceFunctions
  },
  get TenantManager () {
    const TenantManager = require('./client/TenantManager')
    Object.defineProperty(dependencies, 'TenantManager', { value: TenantManager })
    return TenantManager
  },
  */
 inject: (...args) => {
    return require('./cds').inject(...args)
  }
}

module.exports = dependencies
