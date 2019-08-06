import path from 'path';
import fs from 'fs-extra';
import { from, range, of, throwError, empty } from 'rxjs';
import {
  switchMap,
  mergeMap,
  concatMap,
  map,
  pluck,
  tap,
  retryWhen,
  delay,
  mapTo,
  toArray,
} from 'rxjs/operators';
import OSS from 'ali-oss';

const client = new OSS({
  region: process.env.OSS_REGION,
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,
  timeout: process.env.OSS_TIMEOUT || 60 * 1000 * 20,
});

const BACKUP_DIR = process.env.BACKUP_DIR;
if (!BACKUP_DIR) {
  console.log("'BACKUP_DIR' is not defined in the env list");
}

const recordError = (error: any) => {
  fs.appendFile(
    path.join(__dirname, './error.log'),
    `${new Date()}, ${error.message}`,
  )
    .then(() => {})
    .catch(err => {
      console.log(err.message);
    });
};
// mb
const getFileSize = (filepath: string) => {
  return from(fs.stat(filepath)).pipe(
    map(stat => ({
      bytes: stat.size,
      mbSize: +(stat.size / 1000000).toFixed(2),
    })),
  );
};
const getBatch = (totalBytes: number, batchSize: number = 2000000) => {
  const cnt = Math.floor(totalBytes / batchSize);
  const arr = new Array(cnt).fill(batchSize, 0).map((batchSize, index) => ({
    index,
    start: index * batchSize,
    end: (index + 1) * batchSize,
  }));
  const rest = totalBytes - batchSize * cnt;
  if (rest > 0) {
    arr.push({
      index: cnt,
      start: cnt * batchSize,
      end: totalBytes,
    });
  }
  return arr;
};

const $retryWhenDelay = (delayTime = 100, times = 1) =>
  retryWhen(err =>
    err.pipe(
      delay(delayTime),
      concatMap((error, index) =>
        index < times ? of(null) : throwError(error),
      ),
    ),
  );
const multipartUpload = (filepath: string, filename?: string) => {
  if (!filename) filename = path.basename(filepath);
  return from(client.initMultipartUpload(filename)).pipe(
    switchMap(result => {
      return getFileSize(filepath).pipe(
        switchMap(({ bytes, mbSize }) => {
          const batchs = getBatch(bytes);
          console.log(filename, 'total size', bytes, 'batchs', batchs.length);
          return from(batchs);
        }),
        map(item => ({
          ...item,
          uploadId: result.uploadId,
        })),
      );
    }),
    concatMap(({ index, start, end, uploadId }) => {
      console.log(filename, 'Task start', 'part', index + 1, start, end);
      return from(
        client.uploadPart(filename, uploadId, index + 1, filepath, start, end),
      ).pipe(
        map(part => ({
          etag: part.etag,
          number: index + 1,
          uploadId,
        })),
        tap(() => {
          console.log(filename, 'Task done', 'part', index + 1);
        }),
      );
    }),
    toArray(),
    map(parts => ({
      parts: parts.map(o => ({
        etag: o.etag,
        number: o.number,
      })),
      uploadId: parts[0].uploadId,
      filename,
    })),
  );
};
from(fs.readdir(BACKUP_DIR))
  .pipe(
    tap(filenames => console.log('file count', filenames.length)),
    switchMap(filenames =>
      from(filenames).pipe(
        map(filename => ({
          filename,
          filepath: path.join(BACKUP_DIR, filename),
        })),
      ),
    ),
    concatMap(({ filepath, filename }) =>
      multipartUpload(filepath, filename).pipe(
        switchMap(({ filename, parts, uploadId }) => {
          console.log(uploadId, parts);
          return client.completeMultipartUpload(filename, uploadId, parts);
        }),
        mapTo(filepath),
      ),
    ),
    mergeMap(filepath => from(fs.unlink(filepath)).pipe(mapTo(filepath))),
    tap(filepath => console.log(path.basename(filepath), 'delete success')),
  )
  .subscribe({
    next: () => {},
    error: err => {
      console.log(err.message);
      recordError(err);
    },
    complete: () => console.log('COMPLETE'),
  });
