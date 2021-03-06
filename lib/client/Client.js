const postgresClient = require('./postgresClient')

/*
const CustomBuilder = require('../customBuilder/')
const HdbStatement = require('../statement/HdbStatement')
*/
const cdsSql = require('@sap/cds-sql')
const { BaseClient } = cdsSql
const {
  postProcessing: { getPostProcessMapper, getPropertyMapper, getStructMapper }
} = cdsSql
const {
  convertErrorCodeToString
} = require('../util')

class Client extends BaseClient {
  /**
   * Create a Client object.
   *
   * @param {Object} options
   * @param {Object} options.credentials  
   * @param {string} options.credentials.user - username for authentication
   * @param {string} options.credentials.host - database host
   * @param {string} options.credentials.database - database name
   * @param {string} options.credentials.password - password for authentication
   * @param {number} options.credentials.port - database port
   * @param {string} options.credentials.schema - database schema
   *
   */
  constructor ({ credentials }) {
    super(/*[
      ['cds.Boolean', convertToBoolean],
      ['cds.Integer64', convertInt64ToString],
      ['cds.DateTime', convertToISONoMillis],
      ['cds.Timestamp', convertToISO],
      ['cds.LargeString', convertToString]
    ]*/)

    this._credentials = credentials

    const pgClient = postgresClient.Client 

    this._dbc = new pgClient(this._credentials);
    // this._user = 'ANONYMOUS' // Use anonymous user as default
    // auto-commit is true by default
    // this._dbc.setAutoCommit(true)
    this._transCount = 0

    // Does postgres support Streams? For the moment use:
  }

  /**
   * Open database connection.
   *
   * @returns {Promise} Promise that resolves with Client if successful and rejects with error if not.
   */
  connect () {
    return new Promise((resolve, reject) => {

      this._dbc.connect()

      this._isInUse = true

      if (this._credentials.schema) {
        this.execute(`SET SCHEMA '${this._credentials.schema}'`)
          .then(() => {
            resolve(this)
          })
          .catch(err => {
            this._dbc.end()
            reject(convertErrorCodeToString(err))
          })
      } else {
        return resolve(this)
      }
    })
  }

  /**
   * Close database connection.
   *
   * @returns {Promise} Promise that resolves if successful and rejects if not.
   */
  end () {
    this._isInUse = false

    return cdsSql.thenable.resolve(this._dbc.end())
  }

  _getDynatraceDbInfo () {
    return {
      name: `${this._credentials.host}:${this._credentials.port}`, // TODO: Get real name from VCAP
      vendor: 'Postgres',
      host: this._credentials.host,
      port: Number(this._credentials.port)
    }
  }

  /**
   * Execute SQL statement.
   *
   * If execution of SQL statement requires additional values,
   * then the values to be provided as an array.
   * In order to provide multiple value sets with a single execute (example: batch insert)
   * values have to be provided as arrays of values composed in an outer array.
   *
   * Method returns a result object.
   * For example, in case of SELECT the result object contains a result-set.
   * In case of INSERT/DELETE the result object contains a number of affected rows.
   *
   *  The query can be provided as SQL string or as CQN object.
   *
   * @example <caption>Simple Select as SQL string<caption>
   * .execute("SELECT * FROM T")
   * @example <caption>Select with filter as SQL string<caption>
   * .execute("SELECT * FROM T WHERE X = ?", [1])
   * @example <caption>Single Insert as SQL string<caption>
   * .execute("INSERT INTO T (A, B) VALUES (?,?)", [1, 'a'])
   * @example <caption>Multiple Insert as SQL string<caption>
   * .execute("INSERT INTO T (A, B) VALUES (?,?)", [[1, 'a'], [2, 'b']])
   * @example <caption>Simple Select as CQN object<caption>
   * .execute(SELECT.from('T'))
   * @example <caption>Select with filter as CQN object<caption>
   * .execute(SELECT.from('T').where(['x', '=', 1])
   *
   * @param {string|object} query - SQL string or CQN object generated by the DML statements.
   * @param {Array} [values] - Values to be set in the SQL statement if query is provided as string or as CQN object with placeholders.
   * @returns {Promise} Promise, that resolves with result object (array) if successful or rejects with error if not.
   * Result object can be undefined.
   */
  execute (query, values = []) {
    if (this._toBeDestroyed) {
      return cdsSql.thenable.reject(new Error('Client is in an inconsistent state'))
    }

    if (!Array.isArray(values)) {
      return cdsSql.thenable.reject(
        new Error(`Cannot execute SQL statement. Invalid values provided: ${JSON.stringify(values)}`)
      )
    }

    if (typeof query === 'string') {
      return this._executeSQL(query, values, false, new Map())
    }

    if (typeof query === 'function') {
      return this._runBlock(query)
    }

    try {
      if (cdsSql.expand.hasExpand(query)) {
        return this._processExpand(query)
      }

      if (cdsSql.composition.hasCompositionDelete(this._csn && this._csn.definitions, query)) {
        return this._processCascadeDelete(query)
      }

      if (cdsSql.composition.hasDeepInsert(this._csn && this._csn.definitions, query)) {
        return this._processDeepInsert(query)
      }

      if (cdsSql.composition.hasDeepUpdate(this._csn && this._csn.definitions, query)) {
        return this._processDeepUpdate(query)
      }

      return this._execute(query, values)
    } catch (err) {
      // in case an object is passed and sql builder throws an error
      return cdsSql.thenable.reject(convertErrorCodeToString(err))
    }
  }

  /**
   * Stream large binary from Postgres.
   *
   * The query can be provided as SELECT SQL string or as SELECT CQN object selecting exactly one large binary columns.
   *
   * @example <caption>Simple Select as SQL string<caption>
   * .execute("SELECT BLOB FROM T")
   * @example <caption>Select with filter as CQN object<caption>
   * .execute(SELECT.from('T').columns('BLOB').where(['x', '=', 1])
   *
   * @param {string|object} query - SELECT SQL string or SELECT CQN object.
   * @param {Array} [values] - Values to be set in the SQL statement if query is provided as string or as CQN object with placeholders.
   * @returns {Promise} Promise, that resolves with stream if successful or rejects with error if not.
   * Result object can be undefined if no rows obtained.
   */
  async stream (query, values = []) {
    if (!query.SELECT && (typeof query !== 'string' || !query.trim().startsWith('SELECT'))) {
      return cdsSql.thenable.reject(
        new Error(`Cannot stream from Postgres. Invalid query provided: ${JSON.stringify(query)}`)
      )
    }

    values.streaming = true

    const resultSet = await this.execute(query, values)

    if (resultSet.length === 0) {
      return
    }

    // resultset entry always has values
    return Object.values(resultSet[0])[0]
  }

  _execute (cqn, inValues = []) {
    const cqnWithDefaultValues = this._addDefaultValues(cqn, false, true)
    const { sql, values = [] } = cdsSql.builder.sqlFactory(
      cqnWithDefaultValues,
      { typeConversion: this._typeConversionMap, customBuilder: CustomBuilder, user: this._user },
      this._csn
    )

    const propertyMapper = getPropertyMapper(this._csn, cqn, true)
    const outValues = inValues.length > 0 ? inValues : values
    outValues.streaming = inValues.streaming

    return this._executeSQL(
      sql,
      outValues,
      cqn.SELECT && cqn.SELECT.one,
      getPostProcessMapper(this._toService, this._csn, cqn),
      propertyMapper,
      getStructMapper(this._csn, cqn, propertyMapper),
      this._hanaStream &&
        ((cqn.UPDATE && this._hasStreamUpdate(cqn.UPDATE, this._csn)) ||
          (cqn.INSERT && this._hasStreamInsert(cqn.INSERT, this._csn)))
    )
  }

  _hasStreamUpdate (update, csn) {
    if (!csn) {
      return true
    }

    return Object.keys(update.data).some(key => {
      const entity = csn.definitions[update.entity]
      if (entity) {
        const element = entity.elements[key]
        if (element && element['@Core.MediaType']) {
          return true
        }
      }

      return false
    })
  }

  _hasStreamInsertColumns (insert, csn) {
    if (insert.columns) {
      const into = csn.definitions[insert.into]
      if (into) {
        for (const key of insert.columns) {
          const element = into.elements[key]
          if (element && element['@Core.MediaType']) {
            return true
          }
        }
      }
    }

    return false
  }

  _hasStreamInsertEntries (insert, csn) {
    if (insert.entries && insert.entries.length > 0) {
      const into = csn.definitions[insert.into]
      if (into) {
        for (const key of Object.keys(insert.entries[0])) {
          const element = into.elements[key]
          if (element && element['@Core.MediaType']) {
            return true
          }
        }
      }
    }

    return false
  }

  _hasStreamInsert (insert, csn) {
    if (!csn) {
      return true
    }

    if (this._hasStreamInsertColumns(insert, csn)) {
      return true
    }

    return this._hasStreamInsertEntries(insert, csn)
  }

  _processExpand (cqn) {
    const queries = []
    const expandQueries = cdsSql.expand.createJoinCQNFromExpanded(cqn, this._csn, true)

    for (const cqn of expandQueries.queries) {
      cqn._conversionMapper = cdsSql.postProcessing.getPostProcessMapper(this._toService, this._csn, cqn)

      const { sql, values } = cdsSql.builder.sqlFactory(cqn, undefined, this._csn)
      queries.push(this._executeExpand(sql, values))
    }

    return cdsSql.expand.rawToExpanded(expandQueries, queries, cqn.SELECT.one)
  }

  _executeExpand (sql, values) {
    if (Array.isArray(values) && values.length !== 0) {
      return this.preparedExecute(sql, false, values)
    }

    return new Promise((resolve, reject) => {
      this._traced(this._dbc.query, sql, (err, result) => {
        if (err) {
          convertErrorCodeToString(err)
          err.failedQuery = sql
          return reject(err)
        }

        resolve(result)
      })
    })
  }

  _processCascadeDelete (cqn) {
    return this.processNestedCQNs(
      cdsSql.composition.createCascadeDeleteCQNs(this._csn && this._csn.definitions, cqn),
      this._execute.bind(this)
    )
  }

  _processDeepInsert (cqn) {
    return this.processNestedCQNs(
      [cdsSql.composition.createDeepInsertCQNs(this._csn && this._csn.definitions, cqn)],
      this._execute.bind(this)
    )
  }

  _processDeepUpdate (cqn) {
    /* istanbul ignore next */
    return cdsSql.composition
      .selectDeepUpdateData(this._csn && this._csn.definitions, cqn, this._execute.bind(this))
      .then(selectData => {
        return this.processNestedCQNs(
          cdsSql.composition.createDeepUpdateCQNs(this._csn && this._csn.definitions, cqn, selectData),
          this._execute.bind(this)
        )
      })
  }

  _executeSQL (sql, values, isOne, postMapper, propertyMapper, objStructMapper, useHanaClientStatement) {
    if (values.length !== 0) {
      const executed = this.preparedExecute(sql, useHanaClientStatement, values)

      if (this._postProcessNeeded(isOne, postMapper, propertyMapper, objStructMapper)) {
        return executed.then(result => {
          result = this._returnFirstResultIfOne(
            isOne,
            cdsSql.postProcessing.postProcess(result, postMapper, propertyMapper, objStructMapper)
          )
          return result
        })
      }

      return executed
    }

    return new Promise((resolve, reject) => {
      this._traced(this._dbc.query, sql, (err, result) => {
        if (err) {
          convertErrorCodeToString(err)
          err.failedQuery = sql
          return reject(err)
        }

        resolve(
          this._returnFirstResultIfOne(
            isOne,
            cdsSql.postProcessing.postProcess(result, postMapper, propertyMapper, objStructMapper)
          )
        )
      })
    })
  }

  _postProcessNeeded (isOne, postMapper, propertyMapper, objStructMapper) {
    if (isOne) {
      return true
    }

    if (postMapper && postMapper.size) {
      return true
    }

    if (propertyMapper && propertyMapper.size) {
      return true
    }

    return objStructMapper && objStructMapper.size
  }

  _returnFirstResultIfOne (isOne, result) {
    if (isOne) {
      return result.length > 0 ? result[0] : null
    }

    return result
  }

  /**
   * Prepare and execute SQL statement.
   *
   * @param {string} sql - SQL string to be prepared.
   * @param {boolean} useHanaClientStatement - Use HanaClientStatement
   * @param {Array} [values] - Values to be set in the SQL statement if query is provided as string or as CQN object with placeholders.
   * @returns {Promise} Promise, that resolves with HdbStatement if successful and rejects with error if not.
   */

  preparedExecute (sql, useHanaClientStatement, values) {
    const that = this

    return new Promise((resolve, reject) => {
      this._traced(this._preparedExecuteCb, sql, useHanaClientStatement, values, that, (error, results) => {
        if (error) {
          reject(error)
        } else {
          resolve(results)
        }
      })
    })
  }

  /**
   * Wrapper to use callbacks, which are needed for tracing.
   */
  _preparedExecuteCb (sql, useHanaClientStatement, values, client, cb) {
    client
      .prepareStatement(sql, useHanaClientStatement)
      .then(statement => {
        return statement.execute(values)
      })
      .then(results => cb(null, results))
      .catch(error => cb(error))
  }

  /**
   * Prepare SQL statement.
   * Beware: For tracing use preparedExecute instead.
   *
   * @param {string} sql - SQL string to be prepared.
   * @param {boolean} useHanaClientStatement - Use HanaClientStatement
   * @returns {Promise} Promise, that resolves with HdbStatement if successful and rejects with error if not.
   */
  prepareStatement (sql, useHanaClientStatement) {
    return new Promise((resolve, reject) => {
      const cb = (err, statement) => {
        if (err) {
          convertErrorCodeToString(err)
          err.failedQuery = sql

          return reject(err)
        }

        resolve(new HdbStatement(statement, sql, this._hanaStream))
      }

      if (this._hanaStream && useHanaClientStatement) {
        this._hanaStream.createStatement(this._dbc, sql, cb)
      } else {
        this._dbc.prepare(sql, cb)
      }
    })
  }

  /**
   * Returns connection state.
   *
   * @returns {boolean} Returns if client is connected to the database or not.
   */
  isConnected () {
    return this._dbc.readyState === 'connected' || (this._dbc.state && this._dbc.state() === 'connected')
  }

  /**
   * Set database locale.
   *
   * @param {string} locale - String representation of locale.
   * @example
   * "en_US" "de_DE"
   */
  setLocale (locale) {
    this._locale = locale || 'en_US'

    if (this._dbc._connection) {
      // Works, but bad practise to access an internal scope
      this._dbc._connection.getClientInfo().setProperty('LOCALE', this._locale)
    } else {
      this._dbc.setClientInfo('LOCALE', this._locale)
    }
  }

  /**
   * Set database user.
   *
   * @param {string} user - User name.
   *
   * Default is an ANONYMOUS user.
   */
  setUser (user) {
    this._user = user || 'ANONYMOUS' // Use anonymous Postgres user as fallback

    if (this._dbc._connection) {
      // Works, but bad practise to access an internal scope
      this._dbc._connection.getClientInfo().setProperty('XS_APPLICATIONUSER', this._user)
    } else {
      this._dbc.setClientInfo('XS_APPLICATIONUSER', this._user)
    }
  }

  /**
   * Execute begin transaction.
   *
   * @returns {Promise} - Resolves if begin is successful, rejects if not.
   *
   * Note: In the current implementation the auto-commit is always set to false.
   * The begin method is needed for compliance with the Sqlite client.
   * The current implementation always resolves.
   */
  begin () {
    this._transCount++

    if (this._transCount === 1) {
      this._dbc.setAutoCommit(false)
    }

    return cdsSql.thenable.resolve()
  }

  /**
   * Execute commit transaction.
   *
   * @returns {Promise} - Resolves if commit is successful, rejects with error if not.
   */
  commit () {
    if (this._transCount === 0) {
      return cdsSql.thenable.resolve()
    }

    this._transCount--

    if (this._transCount === 0) {
      return new Promise((resolve, reject) => {
        this._traced(this._dbc.commit, err => {
          this._dbc.setAutoCommit(true)

          if (err) {
            return reject(convertErrorCodeToString(err))
          }

          resolve()
        })
      })
    }

    return cdsSql.thenable.resolve()
  }

  /**
   * Execute rollback transaction.
   *
   * @returns {Promise} - Resolves if rollback is successful, rejects with error if not.
   */
  rollback () {
    if (this._transCount === 0) {
      return cdsSql.thenable.resolve()
    }

    this._transCount--

    if (this._transCount === 0) {
      return new Promise((resolve, reject) => {
        this._traced(this._dbc.rollback, err => {
          this._dbc.setAutoCommit(true)

          if (err) {
            return reject(convertErrorCodeToString(err))
          }

          resolve()
        })
      })
    }

    return cdsSql.thenable.resolve()
  }

  /**
   * Forwards deploy to the base class providing client information.
   * @param {Object|Promise} csn - the unreflected CSN or promise that will resolve into csn.
   * @returns {Promise} Promise, that resolves with undefined if successful or rejects with error if not.
   */
  deploy (csn) {
    return super.deploy(csn, 'hana')
  }

  /**
   * As hana does not support 'drop if exists' we need to handle this separately here.
   * Drop should not throw an error in case it was not successful because a table did not exist.
   * So we need to catch all errors related to not existing tables.
   * @private
   */
  _addDropsToChain (chain, drop) {
    return chain.then(() =>
      this.run(drop).catch(err => {
        if (!this._ignoreError(err)) {
          throw err
        }
      })
    )
  }

  _ignoreError (err) {
    // hana error code for table/view does not exist
    return err.code === '259' || err.code === '321'
  }
}

module.exports = Client
