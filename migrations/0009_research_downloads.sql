-- Private prepared market-data downloads. Binary contents never enter Git.
CREATE TABLE research_downloads (
 id TEXT PRIMARY KEY,
 filename TEXT NOT NULL,
 title TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 4194304),
 part_count INTEGER NOT NULL,
 actor TEXT NOT NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
CREATE TABLE research_download_parts (
 download_id TEXT NOT NULL REFERENCES research_downloads(id),
 part INTEGER NOT NULL,
 data_base64 TEXT NOT NULL,
 PRIMARY KEY(download_id,part)
);
