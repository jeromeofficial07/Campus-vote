from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from sqlalchemy.exc import IntegrityError

from models import db, Poll, Candidate, Vote, User

polls_bp = Blueprint("polls", __name__, url_prefix="/api/polls")

def _parse_end_time(raw):
    """Parse an ISO datetime string into a naive UTC datetime, so it can be
    safely compared against datetime.utcnow() everywhere else in this file.
    Accepts a trailing 'Z' (which Python's fromisoformat rejects on its own
    in older versions) and normalizes any timezone-aware value to UTC."""
    if not raw:
        return None
    value = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt

def _is_admin():
    return get_jwt().get("role") == "admin"


@polls_bp.get("")
@jwt_required()
def list_polls():
    from models import VoterParticipation
    polls = Poll.query.order_by(Poll.created_at.desc()).all()
    if not polls:
        return jsonify([]), 200

    students = User.query.filter_by(role="student").all()
    participations = VoterParticipation.query.all()
    legacy_votes = Vote.query.all()

    part_map = {}
    for p in participations:
        part_map.setdefault(p.poll_id, set()).add(p.user_id)
    for v in legacy_votes:
        part_map.setdefault(v.poll_id, set()).add(v.user_id)

    return jsonify([
        p.to_dict(include_results=True, cached_students=students, cached_participations=part_map)
        for p in polls
    ]), 200


@polls_bp.post("")
@jwt_required()
def create_poll():
    if not _is_admin():
        return jsonify({"error": "Only admins can create polls"}), 403

    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    description = data.get("description", "")
    academic_year = (data.get("academic_year") or "2025-2026").strip()
    status = (data.get("status") or "Live").strip()
    max_selections = int(data.get("max_selections") or 1)
    candidates = data.get("candidates") or []
    start_time = data.get("start_time")
    end_time = data.get("end_time")

    if not title or len(candidates) < 2:
        return jsonify({"error": "Title and at least 2 candidates are required"}), 400

    parsed_start_time = None
    if start_time:
        try:
            parsed_start_time = _parse_end_time(start_time)
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid start date/time format."}), 400

    parsed_end_time = None
    if end_time:
        try:
            parsed_end_time = _parse_end_time(end_time)
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid end date/time format."}), 400
        ref_time = parsed_start_time or datetime.utcnow()
        if parsed_end_time <= ref_time:
            return jsonify({"error": "Closing time must be after the starting time."}), 400

    poll = Poll(
        title=title,
        description=description,
        academic_year=academic_year,
        status=status,
        is_active=(status == "Live"),
        max_selections=max_selections,
        created_by=int(get_jwt_identity()),
        start_time=parsed_start_time or datetime.utcnow(),
        end_time=parsed_end_time,
    )
    for c in candidates:
        name = (c.get("name") or "").strip()
        if not name:
            continue
        poll.candidates.append(
            Candidate(
                name=name,
                bio=c.get("bio", ""),
                position=c.get("position", ""),
                department=c.get("department", ""),
                year_of_study=c.get("year_of_study", ""),
                symbol=c.get("symbol", "⚡"),
                verification_status=c.get("verification_status", "Verified"),
                motto=c.get("motto", ""),
                campaign_promises=c.get("campaign_promises", ""),
                photo_url=c.get("photo_url", ""),
            )
        )

    db.session.add(poll)
    db.session.commit()
    return jsonify(poll.to_dict(include_results=True)), 201


@polls_bp.put("/<int:poll_id>")
@jwt_required()
def update_poll(poll_id):
    if not _is_admin():
        return jsonify({"error": "Only admins can edit polls"}), 403

    poll = Poll.query.get_or_404(poll_id)
    data = request.get_json(force=True) or {}
    
    if "title" in data:
        poll.title = (data["title"] or "").strip()
    if "description" in data:
        poll.description = (data["description"] or "").strip()
    if "academic_year" in data:
        poll.academic_year = (data["academic_year"] or "").strip()
    if "status" in data:
        poll.status = (data["status"] or "").strip()
        poll.is_active = (poll.status == "Live")
    if "is_active" in data:
        poll.is_active = bool(data["is_active"])
    if "is_locked" in data:
        poll.is_locked = bool(data["is_locked"])
    if "max_selections" in data:
        poll.max_selections = int(data["max_selections"])
    if "start_time" in data and data["start_time"]:
        try:
            poll.start_time = _parse_end_time(data["start_time"])
        except (ValueError, TypeError):
            pass
    if "end_time" in data and data["end_time"]:
        try:
            parsed = _parse_end_time(data["end_time"])
            poll.end_time = parsed
        except (ValueError, TypeError):
            pass

    db.session.commit()

    from app import socketio
    fresh = poll.to_dict(include_results=True)
    socketio.emit("results_update", fresh, room=f"poll_{poll_id}")
    return jsonify(fresh), 200


@polls_bp.post("/<int:poll_id>/control")
@jwt_required()
def emergency_poll_control(poll_id):
    if not _is_admin():
        return jsonify({"error": "Only admins can execute election controls"}), 403

    poll = Poll.query.get_or_404(poll_id)
    data = request.get_json(force=True) or {}
    action = data.get("action")

    if action == "pause":
        poll.status = "Paused"
        poll.is_active = False
    elif action == "resume":
        poll.status = "Live"
        poll.is_active = True
    elif action == "extend_time":
        minutes = int(data.get("minutes") or 60)
        from datetime import timedelta
        base = poll.end_time or datetime.utcnow()
        poll.end_time = base + timedelta(minutes=minutes)
        poll.status = "Live"
        poll.is_active = True
    elif action == "lock_results":
        poll.is_locked = True
        poll.is_active = False
        poll.status = "Results"
    elif action == "change_status":
        new_status = data.get("status")
        if new_status in ("Draft", "Scheduled", "Live", "Paused", "Closed", "Results"):
            poll.status = new_status
            poll.is_active = (new_status == "Live")

    db.session.commit()

    from app import socketio
    fresh = poll.to_dict(include_results=True)
    socketio.emit("results_update", fresh, room=f"poll_{poll_id}")
    return jsonify(fresh), 200


@polls_bp.delete("/<int:poll_id>")
@jwt_required()
def delete_poll(poll_id):
    if not _is_admin():
        return jsonify({"error": "Only admins can delete polls"}), 403

    poll = Poll.query.get_or_404(poll_id)
    db.session.delete(poll)
    db.session.commit()

    from app import socketio
    socketio.emit("poll_deleted", {"poll_id": poll_id})
    return jsonify({"message": "Poll deleted successfully"}), 200


@polls_bp.post("/<int:poll_id>/candidates")
@jwt_required()
def add_candidate(poll_id):
    if not _is_admin():
        return jsonify({"error": "Only admins can add candidates"}), 403

    poll = Poll.query.get_or_404(poll_id)
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()

    if not name:
        return jsonify({"error": "Candidate name is required"}), 400

    candidate = Candidate(
        poll_id=poll_id,
        name=name,
        bio=(data.get("bio") or "").strip(),
        position=(data.get("position") or "").strip(),
        motto=(data.get("motto") or "").strip(),
        campaign_promises=(data.get("campaign_promises") or "").strip(),
        photo_url=(data.get("photo_url") or "").strip(),
    )
    db.session.add(candidate)
    db.session.commit()

    from app import socketio
    fresh = poll.to_dict(include_results=True)
    socketio.emit("results_update", fresh, room=f"poll_{poll_id}")

    return jsonify(candidate.to_dict(include_results=True)), 201


@polls_bp.patch("/<int:poll_id>/candidates/<int:candidate_id>")
@jwt_required()
def update_candidate(poll_id, candidate_id):
    if not _is_admin():
        return jsonify({"error": "Only admins can edit candidates"}), 403

    candidate = Candidate.query.filter_by(id=candidate_id, poll_id=poll_id).first()
    if not candidate:
        return jsonify({"error": "Candidate not found"}), 404

    data = request.get_json(force=True) or {}
    for field in ("name", "bio", "position", "motto", "campaign_promises", "photo_url"):
        if field in data:
            val = data[field]
            setattr(candidate, field, val.strip() if isinstance(val, str) else val)

    db.session.commit()

    from app import socketio
    poll = Poll.query.get(poll_id)
    fresh = poll.to_dict(include_results=True)
    socketio.emit("results_update", fresh, room=f"poll_{poll_id}")

    return jsonify(candidate.to_dict(include_results=True)), 200


@polls_bp.delete("/<int:poll_id>/candidates/<int:candidate_id>")
@jwt_required()
def delete_candidate(poll_id, candidate_id):
    if not _is_admin():
        return jsonify({"error": "Only admins can delete candidates"}), 403

    candidate = Candidate.query.filter_by(id=candidate_id, poll_id=poll_id).first()
    if not candidate:
        return jsonify({"error": "Candidate not found"}), 404

    db.session.delete(candidate)
    db.session.commit()

    from app import socketio
    poll = Poll.query.get(poll_id)
    fresh = poll.to_dict(include_results=True)
    socketio.emit("results_update", fresh, room=f"poll_{poll_id}")

    return jsonify({"message": "Candidate removed successfully"}), 200


@polls_bp.post("/upload")
@jwt_required()
def upload_candidate_image():
    if not _is_admin():
        return jsonify({"error": "Admin access required"}), 403

    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    import os
    import time
    from werkzeug.utils import secure_filename
    from app import STATIC_DIR

    uploads_dir = os.path.join(STATIC_DIR, "uploads")
    os.makedirs(uploads_dir, exist_ok=True)

    filename = secure_filename(file.filename)
    unique_filename = f"cand_{int(time.time())}_{filename}"
    filepath = os.path.join(uploads_dir, unique_filename)
    file.save(filepath)

    return jsonify({"url": f"/uploads/{unique_filename}"}), 200


@polls_bp.post("/ai-assist")
@jwt_required()
def ai_assist():
    if not _is_admin():
        return jsonify({"error": "Admin access required"}), 403

    data = request.get_json(force=True) or {}
    name = (data.get("name") or "Candidate").strip()
    position = (data.get("position") or "Student Council Leader").strip()

    # Smart AI Manifesto & Motto Generator Engine
    mottos = [
        f"Empowering {name}'s Vision: Innovation, Integrity, Impact.",
        f"Lead with Purpose: Transparent Leadership for Every Student.",
        f"A Stronger Campus Community Starts with {name}.",
        f"Dedicated to Student Excellence & Digital Campus Upgrades.",
    ]
    
    promises = (
        f"1. 24/7 Digital Library & Study Pod Access.\n"
        f"2. Transparent Student Welfare Fund & Subsidized Campus Transport.\n"
        f"3. Modern Cafeteria Upgrades & Eco-friendly Recycling Initiatives."
    )

    import random
    selected_motto = random.choice(mottos)

    return jsonify({
        "motto": selected_motto,
        "position": position,
        "campaign_promises": promises,
        "bio": f"{name} is running for {position} to build an inclusive, forward-thinking, and technology-driven campus environment."
    }), 200


@polls_bp.post("/admin/voters/import-csv")
@jwt_required()
def import_voters_csv():
    if not _is_admin():
        return jsonify({"error": "Admin access required"}), 403

    data = request.get_json(force=True) or {}
    csv_text = data.get("csv_text") or ""
    if not csv_text.strip():
        return jsonify({"error": "CSV content is empty"}), 400

    import csv
    import io

    f = io.StringIO(csv_text.strip())
    reader = csv.DictReader(f)

    imported_count = 0
    updated_count = 0

    for row in reader:
        name = (row.get("name") or row.get("Name") or "").strip()
        email = (row.get("email") or row.get("Email") or "").strip().lower()
        roll_number = (row.get("roll_number") or row.get("Roll Number") or row.get("roll_no") or "").strip()
        department = (row.get("department") or row.get("Department") or "Computer Science").strip()
        year_of_study = (row.get("year") or row.get("Year") or row.get("year_of_study") or "3rd Year").strip()

        if not email or not name:
            continue

        existing = User.query.filter_by(email=email).first()
        if existing:
            existing.name = name
            if roll_number:
                existing.roll_number = roll_number
            existing.department = department
            existing.year_of_study = year_of_study
            updated_count += 1
        else:
            user = User(
                name=name,
                email=email,
                roll_number=roll_number or f"STU-{imported_count+100}",
                role="student",
                department=department,
                year_of_study=year_of_study,
                is_verified=True,
            )
            user.set_password("Student@123")
            db.session.add(user)
            imported_count += 1

    db.session.commit()
    return jsonify({
        "message": f"Successfully imported {imported_count} new voters and updated {updated_count} existing accounts.",
        "imported": imported_count,
        "updated": updated_count,
    }), 200


@polls_bp.patch("/<int:poll_id>/candidates/<int:candidate_id>/verify")
@jwt_required()
def verify_candidate(poll_id, candidate_id):
    if not _is_admin():
        return jsonify({"error": "Admin access required"}), 403

    candidate = Candidate.query.filter_by(id=candidate_id, poll_id=poll_id).first_or_404()
    data = request.get_json(force=True) or {}
    status = data.get("verification_status") or "Verified"

    if status in ("Pending", "Verified", "Rejected"):
        candidate.verification_status = status
        db.session.commit()

        from app import socketio
        poll = Poll.query.get(poll_id)
        socketio.emit("results_update", poll.to_dict(include_results=True), room=f"poll_{poll_id}")

    return jsonify(candidate.to_dict(include_results=True)), 200


@polls_bp.get("/<int:poll_id>")
@jwt_required()
def get_poll(poll_id):
    from models import VoterParticipation
    poll = Poll.query.get_or_404(poll_id)
    user_id = int(get_jwt_identity())

    # Check auto closing
    if poll.end_time and datetime.utcnow() >= poll.end_time and poll.status == "Live":
        poll.status = "Closed"
        poll.is_active = False
        db.session.commit()

    has_voted = (
        VoterParticipation.query.filter_by(poll_id=poll_id, user_id=user_id).first() is not None
        or Vote.query.filter_by(poll_id=poll_id, user_id=user_id).first() is not None
    )

    data = poll.to_dict(include_results=True)
    data["already_voted"] = has_voted
    return jsonify(data), 200


@polls_bp.get("/admin/audit/voters")
@jwt_required()
def admin_audit_voters():
    if not _is_admin():
        return jsonify({"error": "Admin access required"}), 403

    from models import VoterParticipation
    students = User.query.filter_by(role="student").all()
    out = []
    for s in students:
        user_votes = Vote.query.filter_by(user_id=s.id).all()
        user_participations = VoterParticipation.query.filter_by(user_id=s.id).all()
        total_elections_voted = len(user_votes) + len(user_participations)

        out.append({
            "id": s.id,
            "name": s.name,
            "email": s.email,
            "roll_number": s.roll_number,
            "department": s.department or "Computer Science",
            "year_of_study": s.year_of_study or "3rd Year",
            "votes_count": total_elections_voted,
            "is_verified": s.is_verified,
            "status": "Verified Student" if s.is_verified else "Pending Review",
            "integrity_flag": "CLEAN",
        })
    return jsonify(out), 200


@polls_bp.patch("/admin/voters/<int:user_id>/verify")
@jwt_required()
def admin_verify_voter(user_id):
    """Allow admin to approve or revoke a student account's voting eligibility."""
    if not _is_admin():
        return jsonify({"error": "Admin access required"}), 403

    student = User.query.get(user_id)
    if not student or student.role != "student":
        return jsonify({"error": "Student not found"}), 404

    data = request.get_json(force=True) or {}
    action = data.get("action")  # "approve" | "revoke"

    if action == "approve":
        student.is_verified = True
    elif action == "revoke":
        student.is_verified = False
    else:
        return jsonify({"error": "Invalid action. Use 'approve' or 'revoke'."}), 400

    db.session.commit()

    try:
        from app import socketio
        socketio.emit(
            "voter_verified_status",
            {"user_id": student.id, "is_verified": student.is_verified},
            room=f"user_{student.id}"
        )
    except Exception as e:
        print(f"Failed to emit voter_verified_status: {e}")

    return jsonify({
        "message": f"Student account {'approved' if student.is_verified else 'revoked'} successfully.",
        "user": student.to_dict(),
    }), 200


@polls_bp.get("/admin/audit/votes")
@jwt_required()
def admin_audit_votes():
    if not _is_admin():
        return jsonify({"error": "Admin access required"}), 403

    from models import VoterParticipation, AnonymousBallot
    # Decoupled Audit Logs — List voter participation receipts WITHOUT candidate link!
    participations = VoterParticipation.query.order_by(VoterParticipation.voted_at.desc()).all()
    out = []
    for p in participations:
        student = User.query.get(p.user_id)
        poll = Poll.query.get(p.poll_id)
        out.append({
            "vote_id": p.id,
            "poll_id": p.poll_id,
            "poll_title": poll.title if poll else "Election",
            "voter_name": student.name if student else "Unknown",
            "voter_email": student.email if student else "Unknown",
            "voter_roll_number": student.roll_number if student else "N/A",
            "receipt_code": p.receipt_code,
            "anonymous_ballot": "100% Decoupled & Anonymous",
            "timestamp": p.voted_at.isoformat() if p.voted_at else None,
        })
    return jsonify(out), 200


@polls_bp.post("/<int:poll_id>/vote")
@jwt_required()
def cast_vote(poll_id):
    import uuid
    from models import VoterParticipation, AnonymousBallot, OTPRecord, User

    poll = Poll.query.get_or_404(poll_id)
    
    # Auto-close check
    if poll.end_time and datetime.utcnow() >= poll.end_time:
        poll.status = "Closed"
        poll.is_active = False
        db.session.commit()
        return jsonify({"error": "This election has ended and is automatically closed."}), 400

    if not poll.is_active or poll.status in ("Closed", "Paused", "Draft", "Results"):
        return jsonify({"error": f"Voting is not open for this election. Status: {poll.status}"}), 400

    if poll.is_locked:
        return jsonify({"error": "Election results are locked. No further votes allowed."}), 400

    data = request.get_json(force=True) or {}
    candidate_id = data.get("candidate_id")
    candidate = Candidate.query.filter_by(id=candidate_id, poll_id=poll_id).first()
    if not candidate:
        return jsonify({"error": "Invalid candidate selected for this election"}), 400

    user_id = int(get_jwt_identity())

    # Require a real, recently-verified OTP before accepting the vote —
    # without this check, the vote endpoint would accept ballots even if
    # the client skipped the send-otp/verify-otp step entirely.
    user = User.query.get(user_id)

    # Only admin-approved students may vote
    if not user.is_verified:
        return jsonify({"error": "Your account has not been approved by the admin yet. Please wait for admin verification before voting."}), 403

    otp_record = (
        OTPRecord.query.filter_by(
            email=user.email, purpose="vote_verification", is_used=True
        )
        .order_by(OTPRecord.id.desc())
        .first()
    )
    if not otp_record or datetime.utcnow() > otp_record.expires_at:
        return jsonify({"error": "OTP verification required before voting. Please verify your code again."}), 403

    # Strictly enforce 1-person-1-vote
    already_voted = (
        VoterParticipation.query.filter_by(poll_id=poll_id, user_id=user_id).first() is not None
        or Vote.query.filter_by(poll_id=poll_id, user_id=user_id).first() is not None
    )
    if already_voted:
        return jsonify({"error": "You have already cast your vote in this election. Strictly 1 vote per student."}), 409
    # Generate Cryptographic Vote Receipt Code
    receipt_code = "REC-" + uuid.uuid4().hex[:12].upper()

    # 1. Record WHO voted (VoterParticipation - NO candidate link)
    participation = VoterParticipation(
        poll_id=poll_id,
        user_id=user_id,
        receipt_code=receipt_code,
        otp_verified=True,
    )
    db.session.add(participation)

    # 2. Record WHAT candidate was voted for (AnonymousBallot - NO user link!)
    anonymous_ballot = AnonymousBallot(
        poll_id=poll_id,
        candidate_id=candidate_id,
    )
    db.session.add(anonymous_ballot)

    db.session.commit()

    from app import socketio
    fresh = poll.to_dict(include_results=True)
    fresh["already_voted"] = True
    socketio.emit("results_update", fresh, room=f"poll_{poll_id}")

    return jsonify({
        "message": "Your vote has been securely and anonymously recorded.",
        "receipt_code": receipt_code,
        "poll": fresh
    }), 200


@polls_bp.get("/<int:poll_id>/results")
@jwt_required()
def get_results(poll_id):
    poll = Poll.query.get_or_404(poll_id)
    return jsonify(poll.to_dict(include_results=True)), 200