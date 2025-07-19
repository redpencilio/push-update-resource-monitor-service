// see https://github.com/mu-semtech/mu-javascript-template for more info
import bodyParser from 'body-parser';
import { app, query, errorHandler, update, sparqlEscapeUri, sparqlEscapeString, uuid } from 'mu';
app.use(bodyParser.json());

/**
 * We formulate a constraint by subject, predicate and object.  We assume we don't need to filter on the type.
 *
 * The value undefined is interpreted as any value.
 */

/**
 * Connects tabIds to the triple specification for which they have a monitor.
 *
 * The resource is described as an object containing the keys subject, predicate and object.
 */
const tabIdToResources = {};
/**
 * Connects resources (subject, predicate, or object) to the constraints which hold for them and the tabs which are
 * interested in them.
 *
 * Information is stored in a hash-based structure for fast updates.  The hash stores values in subject, predicate,
 * object, tabIds order.
 */
const resourcesToTabId = {};

/**
 * Puts all of the keys in the array nestedKeys into hash.
 *
 * @param {{}} hash Nested datastructure.
 * @param {any} value The value which should be set.
 * @param {string[]} nestedKeys Structure containing the keys and values to be set in hash.
 */
function putHash( hash, value, nestedKeys ) {
  if( nestedKeys.length ) {
    const [key, ...rest] = nestedKeys;
    const moreLevelsAvailable = rest.length;
    const keyExists = key in hash;

    if( moreLevelsAvailable ) {
      if (!keyExists) {
        hash[key] = {};
      }
      putHash( hash[key], value, rest );
    } else {
      hash[key] = value;
    }
  }
}

/**
 * Removes the path of nestedKeys from hash, removing all empty tables in the process.
 *
 * @param {{}} hash Nested datastructure.
 * @param {string[]} nestedKeys Structure containing the keys and values to be set in hash.
 */
function remHash( hash, nestedKeys ) {
  if( nestedKeys.length ) {
    const [key, ...rest] = nestedKeys;
    if( rest.length === 0 ) {
      delete hash[key];
    } else {
      remHash(hash, rest);
      if( Object.keys(hash[key]).length === 0 ) {
        delete hash[key];
      }
    }
  }
}

/**
 * Gets a nested hash path.
 *
 * @param {{}} hash Nested datastructure.
 * @param {string[]} nestedKeys Structure containing the key paths to be gotten.
 */
function getHash( hash, ...nestedKeys ) {
  if( nestedKeys.length === 0 )
    return hash;
  else {
    const [key, ...rest] = nestedKeys;
    const nested = hash[key];
    return nested && getHash(nested, ...rest);
  }
}

/**
 * Gets a nested hash path.
 *
 * @param {{}} hash Nested datastructure.
 * @param {string[][]} nestedKeys Structure containing the key paths to be gotten.  Multiple options may be supplied.
 * @return {[{key,value}]} The result is returned as an array containing keys and corresponding values.
 */
function getHashMultiple( hash, ...nestedKeys ) {
  if( nestedKeys.length === 0 )
    return [{key:[], value: hash}];
  else {
    const [keys, ...rest] = nestedKeys;
    return keys
           .map( (k) => ({key: k, nestedHash: hash[k]}) )
           .filter( ({nestedHash}) => nestedHash )
           .flatMap(({key, nestedHash}) =>
             getHashMultiple(nestedHash, ...rest)
               .map( ({key: nestedKey, value: nestedValue}) =>
                 ({key: [key, ...nestedKey], value: nestedValue})
               ));
  }
}

app.post('/monitor', function( req, res ) {
  const tabId = req.get("MU-TAB-ID");
  const subject = req.query.subject || undefined;
  const predicate = req.query.predicate || undefined;
  const object = req.query.object || undefined;
  /* Monitoring tab ids are optionally written to the triplestore at this point.  If they are not, we cannot verify the
  tabId belongs to the sessionId.  We don't put the check in now, but we might want to do so in the future. */

  // create link from tabId to resource
  tabIdToResources[tabId] ||= {};
  tabIdToResources[tabId][{subject,predicate,object}] = true;
  // create link from resource to tabId
  putHash(resourcesToTabId,true,[subject,predicate,object,tabId]);
  res.status(201).send();
});

app.delete('/monitor', function( req, res ) {
  const tabId = req.get("MU-TAB-ID");
  const subject = req.query.subject || undefined;
  const predicate = req.query.predicate || undefined;
  const object = req.query.object || undefined;
  /* Monitoring tab ids are optionally written to the triplestore at this point.  If they are not, we cannot verify the
  tabId belongs to the sessionId.  We don't put the check in now, but we might want to do so in the future. */

  // delete link from tabId to resource
  tabIdToResources[tabId] ||= {};
  delete tabIdToResources[tabId][{subject,predicate,object}];
  if( Object.keys(tabIdToResources[tabId]).length === 0 )
    delete tabIdToResources[tabId];
    
  // delete link from resource to tabId
  remHash(resourcesToTabId,[subject,predicate,object,tabId]);
  res.status(201).send();
});

app.post('/.mu/delta', async function (req, res) {
  // Maps tabId to interesting quads
  try {
    const messages = {};

    req
      .body
      .flatMap((delta) => [...delta.inserts, ...delta.deletes])
      .forEach((quad) => {
      getHashMultiple(resourcesToTabId,
        [quad.subject.value, undefined],
        [quad.predicate.value, undefined],
        [quad.object.value, undefined]
      )
        .forEach(({ key, value: tabIdMap }) =>
          Object
            .keys(tabIdMap)
            .forEach((tabId) => {
              messages[tabId] ||= [];
              messages[tabId].push({ quad, key });
          }))});

    const sparqlInsertTriples = [];
    if ( Object.keys(messages).length ) {
      for( const tabId in messages ) {
        for( const { quad: _quad, key } of messages[tabId] ) {
          const pushUuid = uuid();
          const pushUri = `http://services.semantic.works/resource-monitor/${pushUuid}`;
          const quadMatchMessage = JSON.stringify({subject: key[0], predicate: key[1], object: key[2]});
          sparqlInsertTriples.push(
            `${sparqlEscapeUri(pushUri)}
            a push:Update;
            mu:uuid ${sparqlEscapeString(pushUuid)};
            push:channel <http://services.semantic.works/resource-monitor>;
            push:target ${sparqlEscapeUri(tabId)};
            push:message ${sparqlEscapeString(quadMatchMessage)}.`);
        }
      }
      await update(`
      PREFIX push: <http://mu.semte.ch/vocabularies/push/>
      PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      INSERT DATA {
    ${sparqlInsertTriples.join("\n")}
    }`);
    }
    res.status(200).send();
  } catch (e) {
    res.status(500).send();
    console.error(e);
  }
});

app.get('/', function( req, res ) {
  res.send('Hello mu-javascript-template');
} );

app.use(errorHandler);
