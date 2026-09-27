import { execFile } from 'node:child_process';

/** @param {string} sql */
export function query(sql) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      [
        'compose',
        '-f',
        'docker-compose.dev.yml',
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'fern',
        '-d',
        'fern',
        '-v',
        'ON_ERROR_STOP=1',
        '-t',
        '-A',
        '-c',
        sql,
      ],
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message));
        else resolve(stdout.trim());
      },
    );
  });
}
