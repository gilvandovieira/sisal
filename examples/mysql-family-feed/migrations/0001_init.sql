-- Tables, constraints, and indexes for the Reddit-style "rising" feed on
-- MySQL/MariaDB. Times are UTC DATETIME(6) literals in
-- YYYY-MM-DD HH:mm:ss.SSS000 form.

create table if not exists posts (
  id varchar(36) primary key,
  title varchar(255) not null,
  body text,
  status varchar(40) not null default 'published',
  score int not null default 0,
  rising_score double not null default 0,
  rising_score_updated_at datetime(6),
  created_at datetime(6) not null,
  updated_at datetime(6) not null,
  index posts_rising_feed_idx
    (status, rising_score desc, rising_score_updated_at desc, id desc),
  index posts_new_feed_idx (status, created_at desc, id desc)
);

create table if not exists post_activity_buckets (
  post_id varchar(36) not null,
  bucket_start datetime(6) not null,
  upvotes int not null default 0,
  downvotes int not null default 0,
  comments int not null default 0,
  reports int not null default 0,
  unique_actors int not null default 0,
  activity_score double not null default 0,
  created_at datetime(6) not null,
  updated_at datetime(6) not null,
  primary key (post_id, bucket_start),
  index post_activity_buckets_post_bucket_idx (post_id, bucket_start desc),
  index post_activity_buckets_bucket_idx (bucket_start desc),
  constraint post_activity_buckets_post_fk
    foreign key (post_id) references posts (id) on delete cascade
);

create table if not exists post_activity_actors (
  post_id varchar(36) not null,
  bucket_start datetime(6) not null,
  actor_id varchar(36) not null,
  created_at datetime(6) not null,
  primary key (post_id, bucket_start, actor_id),
  constraint post_activity_actors_post_fk
    foreign key (post_id) references posts (id) on delete cascade
);
