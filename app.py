import eventlet
eventlet.monkey_patch()

from dotenv import load_dotenv
load_dotenv()

import os
import uuid
from flask import Flask, send_from_directory
from flask_jwt_extended import JWTManager
from flask_socketio import SocketIO, join_room, leave_room

from config import Config
from models import db

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# A fresh random ID generated once per process start. The frontend checks
# this on load and logs the user out automatically if it doesn't match
# what it saw last time — so every server restart forces a fresh login.
BOOT_ID = uuid.uuid4().hex

socketio = SocketIO(
    cors_allowed_origins="*",
    async_mode="eventlet",
    ping_timeout=60,
    ping_interval=25,
)


def create_app():
    app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
    app.config.from_object(Config)

    db.init_app(app)
    JWTManager(app)
    socketio.init_app(app)

    from auth import auth_bp
    from polls import polls_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(polls_bp)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}, 200

    @app.get("/api/boot")
    def boot():
        return {"boot_id": BOOT_ID}, 200

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    with app.app_context():
        _migrate_db()
        _seed_admin()

    return app


def _migrate_db():
    from sqlalchemy import text
    uploads_dir = os.path.join(STATIC_DIR, "uploads")
    os.makedirs(uploads_dir, exist_ok=True)

    # Run DB migration for existing tables BEFORE any ORM queries run
    for table, col, col_type in [
        ("users", "department", "VARCHAR(100) DEFAULT 'Computer Science'"),
        ("users", "year_of_study", "VARCHAR(50) DEFAULT '3rd Year'"),
        # NOTE: existing rows keep is_verified=TRUE (backward compat); only NEW students default to FALSE via ORM
        ("users", "is_verified", "BOOLEAN DEFAULT TRUE"),
        ("polls", "academic_year", "VARCHAR(50) DEFAULT '2025-2026'"),
        ("polls", "status", "VARCHAR(20) DEFAULT 'Live'"),
        ("polls", "is_locked", "BOOLEAN DEFAULT FALSE"),
        ("polls", "max_selections", "INTEGER DEFAULT 1"),
        ("polls", "start_time", "DATETIME"),
        ("polls", "end_time", "DATETIME"),
        ("candidates", "motto", "VARCHAR(255)"),
        ("candidates", "position", "VARCHAR(120)"),
        ("candidates", "department", "VARCHAR(100)"),
        ("candidates", "year_of_study", "VARCHAR(50)"),
        ("candidates", "symbol", "VARCHAR(100)"),
        ("candidates", "verification_status", "VARCHAR(30) DEFAULT 'Verified'"),
        ("candidates", "campaign_promises", "TEXT"),
        ("candidates", "photo_url", "VARCHAR(500)"),
    ]:
        try:
            db.session.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}"))
            db.session.commit()
        except Exception:
            db.session.rollback()

    db.create_all()

    # Ensure all admin users are marked as verified (in case they were seeded before this logic)
    try:
        db.session.execute(text("UPDATE users SET is_verified = TRUE WHERE role = 'admin'"))
        db.session.commit()
    except Exception:
        db.session.rollback()


def _seed_admin():
    from models import User

    if not User.query.filter_by(role="admin").first():
        admin = User(name="Election Admin", email="admin@campus.edu", role="admin", is_verified=True)
        admin.set_password("Admin@123")
        db.session.add(admin)
        db.session.commit()
        print("Seeded default admin -> admin@campus.edu / Admin@123 (please change this)")


@socketio.on("join_poll")
def handle_join_poll(data):
    poll_id = data.get("poll_id")
    if poll_id is not None:
        join_room(f"poll_{poll_id}")


@socketio.on("leave_poll")
def handle_leave_poll(data):
    poll_id = data.get("poll_id")
    if poll_id is not None:
        leave_room(f"poll_{poll_id}")


@socketio.on("join_user")
def handle_join_user(data):
    user_id = data.get("user_id")
    if user_id is not None:
        join_room(f"user_{user_id}")


@socketio.on("leave_user")
def handle_leave_user(data):
    user_id = data.get("user_id")
    if user_id is not None:
        leave_room(f"user_{user_id}")


app = create_app()

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)