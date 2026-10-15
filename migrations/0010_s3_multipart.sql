-- phase: expand
-- S3 multipart uploads (ADR-031, server/s3/multipart.js): an upload in progress and the parts it has received. The
-- parts' bytes are files under OBJECTS_PATH/.tmp/s3mp/<upload id>/; CompleteMultipartUpload joins them into one object
-- (the same commit as PutObject), AbortMultipartUpload and the expiry sweep remove them.
CREATE TABLE media_s3_uploads (
    id              text COLLATE "C" PRIMARY KEY,                -- the S3 UploadId (mpu_<ULID>)
    zone_id         text COLLATE "C" NOT NULL,
    object_key      text COLLATE "C" NOT NULL,
    app_id          text COLLATE "C" NOT NULL,                   -- the project tenant it counts against
    access_key_id   text COLLATE "C" NOT NULL,                   -- who started it
    content_type    text COLLATE "C" NOT NULL,
    metadata        jsonb NOT NULL DEFAULT '{}',                 -- the object metadata the completed object takes
    created_at      bigint NOT NULL,
    expires_at      bigint NOT NULL
);
CREATE INDEX media_s3_uploads_zone ON media_s3_uploads (zone_id, object_key, id);

CREATE TABLE media_s3_parts (
    upload_id       text COLLATE "C" NOT NULL REFERENCES media_s3_uploads (id) ON DELETE CASCADE,
    part_number     integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
    size_bytes      bigint NOT NULL,
    md5             text COLLATE "C" NOT NULL,                   -- hex: the part's ETag
    file_path       text COLLATE "C" NOT NULL,
    created_at      bigint NOT NULL,
    PRIMARY KEY (upload_id, part_number)
);
