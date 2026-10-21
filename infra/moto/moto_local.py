"""Local-only Moto tooling, run inside the pinned image (no host Python)."""

import argparse
from email.parser import Parser
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
from urllib.parse import urlsplit

import boto3
import requests
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

BUCKETS = ("pdf-staging", "pdf-ready")
FIXTURE = b"%PDF-1.4\nMoto smoke fixture\n"
PUBLIC_ACCESS_BLOCK = {
    "BlockPublicAcls": True,
    "IgnorePublicAcls": True,
    "BlockPublicPolicy": True,
    "RestrictPublicBuckets": True,
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def local_endpoint(value):
    url = urlsplit(value)
    require(
        url.scheme == "http"
        and url.hostname in {"moto", "localhost", "127.0.0.1", "::1"}
        and url.port is not None
        and not url.username
        and not url.password
        and url.path in {"", "/"}
        and not url.query
        and not url.fragment,
        "Endpoint rejected: use an explicit http://moto:port or loopback endpoint.",
    )
    return value.rstrip("/")


def client(endpoint=None):
    return boto3.client(
        "s3",
        endpoint_url=local_endpoint(endpoint or os.environ.get("MOTO_ENDPOINT", "http://moto:5000")),
        region_name="us-east-1",
        aws_access_key_id="moto-local",
        aws_secret_access_key="moto-local-secret",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            connect_timeout=2,
            read_timeout=2,
            retries={"total_max_attempts": 1},
            proxies={},
        ),
    )


def frontend_origin():
    value = os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")
    url = urlsplit(value)
    require(
        url.scheme in {"http", "https"}
        and url.hostname
        and "*" not in value
        and not url.username
        and not url.password
        and not url.path
        and not url.query
        and not url.fragment,
        "FRONTEND_ORIGIN must be one exact http(s) origin without a trailing slash.",
    )
    return value


def cors_rules():
    return [{
        "AllowedOrigins": [frontend_origin()],
        "AllowedMethods": ["PUT", "POST"],
        "AllowedHeaders": ["content-type", "x-amz-*"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 300,
    }]


def ready(s3):
    attempts = int(os.environ.get("MOTO_READY_ATTEMPTS", "15"))
    require(1 <= attempts <= 30, "MOTO_READY_ATTEMPTS must be between 1 and 30.")
    for attempt in range(attempts):
        try:
            s3.list_buckets()
            print("S3 readiness check passed (bucket provisioning checked separately).")
            return
        except (BotoCoreError, ClientError):
            if attempt + 1 == attempts:
                raise ValueError("S3 unavailable after bounded retries; check the Moto container and endpoint.") from None
            time.sleep(1)


def optional(operation, absent_code, **kwargs):
    """Suppress only the API's documented absent-configuration response."""
    try:
        return operation(**kwargs)
    except ClientError as error:
        if error.response["Error"]["Code"] != absent_code:
            raise
        return {}


def check_compatible(s3, bucket):
    versioning = s3.get_bucket_versioning(Bucket=bucket)
    require("Status" not in versioning, f"{bucket}: versioning is incompatible; reset disposable storage explicitly.")
    lock = optional(s3.get_object_lock_configuration, "ObjectLockConfigurationNotFoundError", Bucket=bucket)
    require(not lock.get("ObjectLockConfiguration"), f"{bucket}: object lock is incompatible; reset disposable storage explicitly.")


def check_configuration(s3):
    for bucket in BUCKETS:
        check_compatible(s3, bucket)
        acl = s3.get_bucket_acl(Bucket=bucket)
        grants = acl["Grants"]
        require(
            len(grants) == 1
            and grants[0]["Permission"] == "FULL_CONTROL"
            and grants[0]["Grantee"].get("Type") == "CanonicalUser"
            and grants[0]["Grantee"].get("ID") == acl["Owner"]["ID"],
            f"{bucket}: expected a private owner-only ACL.",
        )
        block = s3.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]
        require(block == PUBLIC_ACCESS_BLOCK, f"{bucket}: public-access-block flags do not match.")
        policy = optional(s3.get_bucket_policy, "NoSuchBucketPolicy", Bucket=bucket)
        require("Policy" not in policy, f"{bucket}: unexpected bucket policy.")
        lifecycle = optional(s3.get_bucket_lifecycle_configuration, "NoSuchLifecycleConfiguration", Bucket=bucket)
        require(not lifecycle.get("Rules"), f"{bucket}: lifecycle rules must be absent.")
        notifications = s3.get_bucket_notification_configuration(Bucket=bucket)
        require(
            not {key: value for key, value in notifications.items() if key != "ResponseMetadata"},
            f"{bucket}: notification targets must be absent.",
        )
        cors = optional(s3.get_bucket_cors, "NoSuchCORSConfiguration", Bucket=bucket)
        expected_cors = cors_rules() if bucket == "pdf-staging" else []
        require(cors.get("CORSRules", []) == expected_cors, f"{bucket}: CORS configuration does not match.")
    print("Bucket configuration readback passed (not an AWS authorization test).")


def bootstrap(s3):
    rules = cors_rules()
    for bucket in BUCKETS:
        try:
            s3.head_bucket(Bucket=bucket)
        except ClientError as error:
            if error.response["Error"]["Code"] not in {"404", "NoSuchBucket"}:
                raise
            s3.create_bucket(Bucket=bucket)
        check_compatible(s3, bucket)
    for bucket in BUCKETS:
        s3.put_bucket_acl(Bucket=bucket, ACL="private")
        s3.put_public_access_block(Bucket=bucket, PublicAccessBlockConfiguration=PUBLIC_ACCESS_BLOCK)
        s3.delete_bucket_policy(Bucket=bucket)
        s3.delete_bucket_lifecycle(Bucket=bucket)
        s3.put_bucket_notification_configuration(Bucket=bucket, NotificationConfiguration={})
    s3.put_bucket_cors(Bucket="pdf-staging", CORSConfiguration={"CORSRules": rules})
    s3.delete_bucket_cors(Bucket="pdf-ready")
    check_configuration(s3)
    print("Bucket provisioning completed.")


def http_request(method, url, **kwargs):
    # Do not route local emulator traffic through inherited proxy settings.
    with requests.Session() as session:
        session.trust_env = False
        return session.request(method, url, timeout=5, allow_redirects=False, **kwargs)


def header_values(response, name):
    return {value.strip().lower() for value in response.headers.get(name, "").split(",") if value.strip()}


def check_cors(s3):
    endpoint = local_endpoint(s3.meta.endpoint_url)
    origin = frontend_origin()
    unrelated = "https://unconfigured.invalid" if origin != "https://unconfigured.invalid" else "https://other.invalid"
    key = f"moto-smoke/{uuid.uuid4().hex}"
    url = f"{endpoint}/pdf-staging/{key}"
    try:
        for method in ("PUT", "POST"):
            headers = {
                "Origin": origin,
                "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "content-type,x-amz-meta-smoke",
            }
            response = http_request("OPTIONS", url, headers=headers)
            require(response.status_code == 200, f"{method} upload preflight failed.")
            require(response.headers.get("Access-Control-Allow-Origin") == origin, "Configured origin was not allowed.")
            require(method.lower() in header_values(response, "Access-Control-Allow-Methods"), "Upload method was not allowed.")
            allowed = header_values(response, "Access-Control-Allow-Headers")
            require("content-type" in allowed and bool({"x-amz-*", "x-amz-meta-smoke"} & allowed), "Upload headers were not allowed.")
            headers["Origin"] = unrelated
            denied = http_request("OPTIONS", url, headers=headers)
            require("Access-Control-Allow-Origin" not in denied.headers, "Unconfigured origin received a CORS allowance.")
            headers["Origin"] = origin
            ready_response = http_request("OPTIONS", f"{endpoint}/pdf-ready/{key}", headers=headers)
            require("Access-Control-Allow-Origin" not in ready_response.headers, "Ready storage received a browser CORS allowance.")
        response = http_request("PUT", url, data=b"cors fixture", headers={"Origin": origin, "Content-Type": "application/pdf"})
        require(response.status_code == 200, "CORS upload failed.")
        require(response.headers.get("Access-Control-Allow-Origin") == origin, "Upload response did not allow configured origin.")
        require("etag" in header_values(response, "Access-Control-Expose-Headers") and response.headers.get("ETag"), "Upload response did not expose ETag.")
        denied_upload = http_request("PUT", url, data=b"cors fixture", headers={"Origin": unrelated, "Content-Type": "application/pdf"})
        require("Access-Control-Allow-Origin" not in denied_upload.headers, "Unconfigured upload origin received a CORS allowance.")
    finally:
        try:
            s3.delete_object(Bucket="pdf-staging", Key=key)
        except (BotoCoreError, ClientError):
            print(f"Fixture cleanup failed: pdf-staging/{key}", file=sys.stderr)
            raise
    print("CORS checks passed for configured/unconfigured origins and ready storage.")


def require_absent(s3, bucket, key):
    try:
        s3.head_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if error.response["Error"]["Code"] in {"404", "NoSuchKey"}:
            return
        raise
    raise ValueError(f"{bucket}: fixture still exists after deletion.")


def smoke(s3):
    check_configuration(s3)
    check_cors(s3)
    key = f"moto-smoke/{uuid.uuid4().hex}"
    try:
        s3.put_object(Bucket="pdf-staging", Key=key, Body=FIXTURE, ContentType="application/pdf")
        listing = s3.list_objects_v2(Bucket="pdf-staging", Prefix=key)
        require(key in {obj["Key"] for obj in listing.get("Contents", [])}, "Staging listing did not contain the fixture.")
        require(s3.get_object(Bucket="pdf-staging", Key=key)["Body"].read() == FIXTURE, "Staging bytes differ.")
        s3.copy_object(Bucket="pdf-ready", Key=key, CopySource={"Bucket": "pdf-staging", "Key": key})
        require(s3.get_object(Bucket="pdf-ready", Key=key)["Body"].read() == FIXTURE, "Copied ready bytes differ.")
        s3.delete_object(Bucket="pdf-staging", Key=key)
        require_absent(s3, "pdf-staging", key)
    finally:
        for bucket in BUCKETS:
            try:
                s3.delete_object(Bucket=bucket, Key=key)
                require_absent(s3, bucket, key)
            except (BotoCoreError, ClientError, ValueError):
                print(f"Fixture cleanup failed: {bucket}/{key}", file=sys.stderr)
                raise
    print("Storage smoke passed: staging upload/list/read, copy/read equality, source deletion; fixtures removed.")


def sign_put(key):
    endpoint = local_endpoint(os.environ.get("MOTO_HOST_ENDPOINT", "http://localhost:5000"))
    require(urlsplit(endpoint).hostname != "moto", "Signing requires a host-reachable loopback endpoint.")
    url = client(endpoint).generate_presigned_url(
        "put_object",
        Params={"Bucket": "pdf-staging", "Key": key, "ContentType": "application/pdf"},
        ExpiresIn=60,
        HttpMethod="PUT",
    )
    # A private host temporary directory is mounted here by check.sh. Never log URL.
    config = [
        f"url = {json.dumps(url)}",
        f"header = {json.dumps('Origin: ' + frontend_origin())}",
        'header = "Content-Type: application/pdf"',
        'noproxy = "*"',
        'proto = "=http"',
        'connect-timeout = 3',
        'max-time = 10',
        'silent',
        'fail',
    ]
    Path("/output/upload.curl").write_text("\n".join(config) + "\n")


def host_headers(name):
    # curl writes an HTTP status line followed by RFC-style headers.
    lines = Path("/output", name).read_text().splitlines()
    require(lines and lines[0].startswith("HTTP/1.1 200"), f"Host {name}: expected HTTP 200.")
    return Parser().parsestr("\n".join(lines[1:]))


def verify_host(s3, key):
    preflight = host_headers("preflight.headers")
    upload = host_headers("upload.headers")
    for headers in (preflight, upload):
        require(headers.get("Access-Control-Allow-Origin") == frontend_origin(), "Host request did not allow configured origin.")
    require("put" in {value.strip().lower() for value in preflight.get("Access-Control-Allow-Methods", "").split(",")}, "Host preflight did not allow PUT.")
    require("content-type" in {value.strip().lower() for value in preflight.get("Access-Control-Allow-Headers", "").split(",")}, "Host preflight did not allow Content-Type.")
    require("etag" in {value.strip().lower() for value in upload.get("Access-Control-Expose-Headers", "").split(",")} and upload.get("ETag"), "Host upload did not expose ETag.")
    require(s3.get_object(Bucket="pdf-staging", Key=key)["Body"].read() == FIXTURE, "Host signed-upload bytes differ.")
    print("Host signed PUT and browser-equivalent preflight passed (compatibility evidence only).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["ready", "bootstrap", "check", "cors", "smoke", "sign-put", "verify-host", "cleanup"])
    parser.add_argument("key", nargs="?")
    args = parser.parse_args()
    s3 = client()
    if args.command in {"sign-put", "verify-host", "cleanup"}:
        require(args.key and re.fullmatch(r"moto-smoke/[A-Za-z0-9.-]+", args.key), "Expected a unique moto-smoke fixture key.")
        if args.command == "sign-put":
            sign_put(args.key)
        elif args.command == "verify-host":
            verify_host(s3, args.key)
        else:
            s3.delete_object(Bucket="pdf-staging", Key=args.key)
            require_absent(s3, "pdf-staging", args.key)
    else:
        {"ready": ready, "bootstrap": bootstrap, "check": check_configuration, "cors": check_cors, "smoke": smoke}[args.command](s3)


if __name__ == "__main__":
    try:
        main()
    except ClientError as error:
        print(f"ERROR: {error.operation_name} failed ({error.response['Error']['Code']}); check Moto configuration.", file=sys.stderr)
        sys.exit(1)
    except BotoCoreError:
        print("ERROR: S3 request failed; check the Moto container and local endpoint.", file=sys.stderr)
        sys.exit(1)
    except requests.RequestException:
        print("ERROR: Local HTTP check failed; check the Moto endpoint.", file=sys.stderr)
        sys.exit(1)
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
