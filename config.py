import os
from datetime import timedelta

BASE_DIR = os.path.abspath(os.path.dirname(__file__))


class Config:
    raw_db_url = os.environ.get(
        "DATABASE_URL",
        f"sqlite:///{os.path.join(BASE_DIR, 'campus_vote.db')}"
    )
    # Cloud providers (Render, Supabase, Neon, Railway) often supply 'postgres://' which SQLAlchemy requires as 'postgresql://'
    if raw_db_url.startswith("postgres://"):
        raw_db_url = raw_db_url.replace("postgres://", "postgresql://", 1)

    SQLALCHEMY_DATABASE_URI = raw_db_url
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    JWT_SECRET_KEY = os.environ.get(
        "JWT_SECRET_KEY", "campus-vote-jwt-secret-key-32chars-minimum!"
    )
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=8)

    SECRET_KEY = os.environ.get(
        "SECRET_KEY", "campus-vote-app-secret-key-32chars-minimum!"
    )

    # Gmail SMTP Configuration for OTP
    GMAIL_USER = os.environ.get("GMAIL_USER", "")
    GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")

    CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")

    # Enable browser caching for static assets (React, CSS, images) for fast load speeds
    SEND_FILE_MAX_AGE_DEFAULT = 3600
