// Report only known, non-sensitive error classes. Never put raw logs, URLs or
// provider credentials into the administrator status message.
export function describeStartupFailure(log:string):string {
  if(/\bEADDRINUSE\b/.test(log))return 'The configured port was already in use.';
  if(/\bEACCES\b|\bEPERM\b/.test(log))return 'The server was denied access to a required file or socket.';
  if(/\bERR_MODULE_NOT_FOUND\b|\bMODULE_NOT_FOUND\b/.test(log))return 'A required application module could not be loaded.';
  if(/does not provide an export named/.test(log))return 'An application module is missing a required export.';
  if(/\bERR_UNSUPPORTED_TYPESCRIPT_SYNTAX\b|\bERR_INVALID_TYPESCRIPT_SYNTAX\b/.test(log))return 'The installed Node.js runtime could not load application TypeScript.';
  if(/\bSQLITE_BUSY\b|database is locked/i.test(log))return 'The database was locked during startup.';
  if(/\bSQLITE_CORRUPT\b|database disk image is malformed/i.test(log))return 'SQLite reported a database integrity error.';
  if(/\bSQLITE_[A-Z_]+\b/.test(log))return 'SQLite rejected a startup operation.';
  if(/\bENOSPC\b/.test(log))return 'The server ran out of disk space.';
  if(/\bENOMEM\b|heap out of memory/i.test(log))return 'The server ran out of memory.';
  if(/\bSyntaxError\b/.test(log))return 'Node.js rejected application syntax or module linkage.';
  if(/\bReferenceError\b/.test(log))return 'Application startup referenced an undefined value.';
  if(/\bTypeError\b/.test(log))return 'Application startup encountered a type error.';
  return '';
}
