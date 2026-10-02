/**
 * Amazon S3 tile store.
 *
 * Objects are written with the headers a browser or edge cache needs —
 * gzip encoding and an immutable cache lifetime — so a tile object is
 * servable exactly as stored, by any layer, without transformation.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const PREFIX = "tiles/";

const isMissing = (error) =>
  error?.name === "NoSuchKey" || error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404;

export class S3Store {
  /**
   * @param {{region: string, bucket: string}} options - Bucket location
   */
  constructor({ region, bucket }) {
    if (!bucket) throw new Error("TILE_BUCKET is required when PLATFORM=aws");
    this.client = new S3Client({ region });
    this.bucket = bucket;
  }

  /**
   * @param {string} key - Tile key
   * @returns {Promise<Buffer|null>} Stored bytes, or null when absent
   */
  async get(key) {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: PREFIX + key }),
      );
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * @param {string} key - Tile key
   * @returns {Promise<boolean>} True when present
   */
  async has(key) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: PREFIX + key }));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /**
   * @param {string} key - Tile key
   * @param {Buffer} bytes - Gzipped tile
   * @returns {Promise<void>}
   */
  async put(key, bytes) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: PREFIX + key,
        Body: bytes,
        ContentType: "application/x-fractal-tile",
        ContentEncoding: "gzip",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
  }
}
