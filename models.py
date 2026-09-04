from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    roll_number = db.Column(db.String(50), unique=True, nullable=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default="student")  # student | admin
    department = db.Column(db.String(100), nullable=True, default="Computer Science")
    year_of_study = db.Column(db.String(50), nullable=True, default="3rd Year")
    is_verified = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    votes = db.relationship("Vote", backref="voter", lazy=True)

    def set_password(self, raw_password):
        self.password_hash = generate_password_hash(raw_password)

    def check_password(self, raw_password):
        return check_password_hash(self.password_hash, raw_password)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "roll_number": self.roll_number,
            "role": self.role,
            "department": self.department,
            "year_of_study": self.year_of_study,
            "is_verified": self.is_verified,
        }


class Poll(db.Model):
    __tablename__ = "polls"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    academic_year = db.Column(db.String(50), nullable=True, default="2025-2026")
    status = db.Column(db.String(20), default="Live")  # Draft | Scheduled | Live | Paused | Closed | Results
    is_active = db.Column(db.Boolean, default=True)
    is_locked = db.Column(db.Boolean, default=False)
    max_selections = db.Column(db.Integer, default=1)
    start_time = db.Column(db.DateTime, default=datetime.utcnow)
    end_time = db.Column(db.DateTime, nullable=True)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    candidates = db.relationship(
        "Candidate", backref="poll", lazy=True, cascade="all, delete-orphan"
    )
    votes = db.relationship("Vote", backref="poll", lazy=True, cascade="all, delete-orphan")
    voter_participations = db.relationship(
        "VoterParticipation", backref="poll_ref", lazy=True, cascade="all, delete-orphan"
    )
    anonymous_ballots = db.relationship(
        "AnonymousBallot", backref="poll", lazy=True, cascade="all, delete-orphan"
    )

    def to_dict(self, include_results=False, cached_students=None, cached_participations=None):
        # Auto-close election if end_time has expired
        curr_status = self.status or ("Live" if self.is_active else "Closed")
        curr_active = self.is_active
        if self.end_time and datetime.utcnow() >= self.end_time and curr_status == "Live":
            curr_status = "Closed"
            curr_active = False

        students = cached_students if cached_students is not None else User.query.filter_by(role="student").all()
        total_eligible = len(students)

        if cached_participations is not None:
            voted_user_ids = cached_participations.get(self.id, set())
        else:
            participations = VoterParticipation.query.filter_by(poll_id=self.id).all()
            legacy_votes = Vote.query.filter_by(poll_id=self.id).all()
            voted_user_ids = set([p.user_id for p in participations] + [v.user_id for v in legacy_votes])

        votes_cast = len(voted_user_ids)
        remaining_voters = max(0, total_eligible - votes_cast)
        turnout_pct = min(100.0, round((votes_cast / total_eligible * 100), 1)) if total_eligible > 0 else 0

        # Department-wise turnout breakdown
        dept_counts = {}
        for s in students:
            dept = s.department or "Computer Science"
            if dept not in dept_counts:
                dept_counts[dept] = {"total": 0, "voted": 0}
            dept_counts[dept]["total"] += 1
            if s.id in voted_user_ids:
                dept_counts[dept]["voted"] += 1

        dept_turnout = []
        for dept, info in dept_counts.items():
            pct = round((info["voted"] / info["total"] * 100), 1) if info["total"] > 0 else 0
            dept_turnout.append({
                "department": dept,
                "total": info["total"],
                "voted": info["voted"],
                "percentage": pct
            })

        # Year-wise turnout breakdown
        year_counts = {}
        for s in students:
            yr = s.year_of_study or "3rd Year"
            if yr not in year_counts:
                year_counts[yr] = {"total": 0, "voted": 0}
            year_counts[yr]["total"] += 1
            if s.id in voted_user_ids:
                year_counts[yr]["voted"] += 1

        year_turnout = []
        for yr, info in year_counts.items():
            pct = round((info["voted"] / info["total"] * 100), 1) if info["total"] > 0 else 0
            year_turnout.append({
                "year_of_study": yr,
                "total": info["total"],
                "voted": info["voted"],
                "percentage": pct
            })

        data = {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "academic_year": self.academic_year or "2025-2026",
            "status": curr_status,
            "is_active": curr_active,
            "is_locked": self.is_locked,
            "max_selections": self.max_selections or 1,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "total_votes": votes_cast,
            "total_eligible_voters": total_eligible,
            "remaining_voters": remaining_voters,
            "voting_percentage": turnout_pct,
            "department_turnout": dept_turnout,
            "year_turnout": year_turnout,
            "candidates": [c.to_dict(include_results) for c in self.candidates],
        }
        return data


class Candidate(db.Model):
    __tablename__ = "candidates"

    id = db.Column(db.Integer, primary_key=True)
    poll_id = db.Column(db.Integer, db.ForeignKey("polls.id"), nullable=False)
    name = db.Column(db.String(120), nullable=False)
    bio = db.Column(db.String(255), nullable=True)
    motto = db.Column(db.String(255), nullable=True)
    position = db.Column(db.String(120), nullable=True)
    department = db.Column(db.String(100), nullable=True)
    year_of_study = db.Column(db.String(50), nullable=True)
    symbol = db.Column(db.String(100), nullable=True)
    verification_status = db.Column(db.String(30), default="Verified")  # Pending | Verified | Rejected
    campaign_promises = db.Column(db.Text, nullable=True)
    photo_url = db.Column(db.String(500), nullable=True)

    votes = db.relationship("Vote", backref="candidate", lazy=True)
    anonymous_ballots = db.relationship("AnonymousBallot", backref="candidate", lazy=True)

    def to_dict(self, include_results=False):
        data = {
            "id": self.id,
            "name": self.name,
            "bio": self.bio,
            "motto": self.motto,
            "position": self.position,
            "department": self.department,
            "year_of_study": self.year_of_study,
            "symbol": self.symbol or "⚡",
            "verification_status": self.verification_status or "Verified",
            "campaign_promises": self.campaign_promises,
            "photo_url": self.photo_url,
        }
        if include_results:
            data["vote_count"] = len(self.votes) + len(self.anonymous_ballots)
        return data


class Vote(db.Model):
    __tablename__ = "votes"

    id = db.Column(db.Integer, primary_key=True)
    poll_id = db.Column(db.Integer, db.ForeignKey("polls.id"), nullable=False)
    candidate_id = db.Column(db.Integer, db.ForeignKey("candidates.id"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint("poll_id", "user_id", name="uq_one_vote_per_poll"),
    )


class VoterParticipation(db.Model):
    """Tracks WHO HAS VOTED for 1-person-1-vote enforcement without recording candidate selection."""
    __tablename__ = "voter_participations"

    id = db.Column(db.Integer, primary_key=True)
    poll_id = db.Column(db.Integer, db.ForeignKey("polls.id"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    receipt_code = db.Column(db.String(100), nullable=False)
    otp_verified = db.Column(db.Boolean, default=True)
    voted_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship("User", backref="participations", lazy=True)

    __table_args__ = (
        db.UniqueConstraint("poll_id", "user_id", name="uq_voter_poll_participation"),
    )


class AnonymousBallot(db.Model):
    """100% Anonymous Decoupled Ballot Box — Stores NO user_id link whatsoever."""
    __tablename__ = "anonymous_ballots"

    id = db.Column(db.Integer, primary_key=True)
    poll_id = db.Column(db.Integer, db.ForeignKey("polls.id"), nullable=False)
    candidate_id = db.Column(db.Integer, db.ForeignKey("candidates.id"), nullable=False)
    cast_at = db.Column(db.DateTime, default=datetime.utcnow)


class OTPRecord(db.Model):
    """Stores temporary 6-digit OTP verification codes."""
    __tablename__ = "otp_records"

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), nullable=False, index=True)
    otp_code = db.Column(db.String(10), nullable=False)
    purpose = db.Column(db.String(50), default="vote_verification")
    expires_at = db.Column(db.DateTime, nullable=False)
    is_used = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
