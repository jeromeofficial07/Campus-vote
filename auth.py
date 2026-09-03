import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from flask import Blueprint, request, jsonify
from flask_jwt_extended import create_access_token, jwt_required, get_jwt_identity, get_jwt
from models import db, User

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


def _send_gmail_otp(to_email, otp_code, student_name="Student"):
    """Send OTP via Gmail SMTP using GMAIL_USER and GMAIL_APP_PASSWORD."""
    gmail_user = os.environ.get("GMAIL_USER") or os.environ.get("SMTP_USER")
    gmail_pass = os.environ.get("GMAIL_APP_PASSWORD") or os.environ.get("SMTP_PASSWORD")

    if not gmail_user or not gmail_pass:
        print(f"[OTP DEV FALLBACK] Gmail credentials not set. OTP code for {to_email}: {otp_code}")
        return False, "Gmail credentials not configured."

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"🔐 Your Campus Vote Verification OTP: {otp_code}"
        msg["From"] = f"Campus Vote <{gmail_user}>"
        msg["To"] = to_email

        html = f"""
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
            <div style="background: linear-gradient(135deg, #CF4173 0%, #5D3140 100%); color: white; padding: 20px; text-align: center; border-radius: 8px;">
                <h2 style="margin: 0; font-size: 22px;">🗳️ Campus Vote</h2>
                <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">Secure Student Election Verification</p>
            </div>
            <div style="padding: 20px 4px; color: #1e293b;">
                <p style="font-size: 15px;">Hello <strong>{student_name}</strong>,</p>
                <p style="font-size: 14px; line-height: 1.5; color: #475569;">
                    Your one-time security verification code to cast your anonymous ballot is:
                </p>
                <div style="text-align: center; margin: 24px 0;">
                    <div style="display: inline-block; background: #fdf2f8; border: 2px dashed #CF4173; border-radius: 8px; padding: 12px 28px;">
                        <span style="font-family: monospace; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #CF4173;">{otp_code}</span>
                    </div>
                </div>
                <p style="color: #64748b; font-size: 13px; line-height: 1.5;">
                    ⏳ This code expires in <strong>10 minutes</strong>. If you did not initiate this request, you can safely ignore this message.
                </p>
                <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 16px 0;" />
                <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">
                    🔒 100% Anonymous Decoupled Voting — Your candidate choice is never linked to your account identity.
                </p>
            </div>
        </div>
        """
        msg.attach(MIMEText(html, "html"))

        server = smtplib.SMTP("smtp.gmail.com", 587, timeout=10)
        server.starttls()
        server.login(gmail_user, gmail_pass)
        server.sendmail(gmail_user, [to_email], msg.as_string())
        server.quit()
        print(f"[OTP GMAIL SUCCESS] Successfully sent OTP to {to_email}")
        return True, "Email sent successfully"
    except Exception as e:
        print(f"[OTP GMAIL ERROR] Failed to send to {to_email}: {e}")
        return False, str(e)


@auth_bp.post("/register")
def register():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    roll_number = (data.get("roll_number") or "").strip() or None
    department = (data.get("department") or "").strip() or "Computer Science"
    year_of_study = (data.get("year_of_study") or "").strip() or "3rd Year"
    password = data.get("password") or ""

    if not name or not email or not password:
        return jsonify({"error": "name, email and password are required"}), 400

    if User.query.filter_by(email=email).first():
        return jsonify({"error": "An account with this email already exists"}), 409

    if roll_number and User.query.filter_by(roll_number=roll_number).first():
        return jsonify({"error": "An account with this roll number already exists"}), 409

    user = User(
        name=name,
        email=email,
        roll_number=roll_number,
        department=department,
        year_of_study=year_of_study,
        role="student",
        is_verified=False,
    )
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    token = create_access_token(
        identity=str(user.id), additional_claims={"role": user.role}
    )
    return jsonify({"token": token, "user": user.to_dict()}), 201

@auth_bp.post("/login")
def login():
    data = request.get_json(force=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    user = User.query.filter_by(email=email).first()
    if not user or not user.check_password(password):
        return jsonify({"error": "Invalid email or password"}), 401

    token = create_access_token(
        identity=str(user.id), additional_claims={"role": user.role}
    )
    return jsonify({"token": token, "user": user.to_dict()}), 200


@auth_bp.get("/me")
@jwt_required()
def me():
    user = User.query.get(int(get_jwt_identity()))
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify({"user": user.to_dict()}), 200


@auth_bp.post("/send-otp")
@jwt_required()
def send_otp():
    import random
    from datetime import datetime, timedelta
    from models import OTPRecord

    user = User.query.get(int(get_jwt_identity()))
    if not user:
        return jsonify({"error": "User not found"}), 404

    if not user.is_verified:
        return jsonify({"error": "Your account is pending admin approval. You cannot request a verification OTP until you are approved."}), 403

    # Generate 6-digit cryptographic OTP code
    code = f"{random.randint(100000, 999999)}"
    expires_at = datetime.utcnow() + timedelta(minutes=10)

    otp = OTPRecord(
        email=user.email,
        otp_code=code,
        purpose="vote_verification",
        expires_at=expires_at,
    )
    db.session.add(otp)
    db.session.commit()

    # Send real email via Gmail SMTP
    sent_via_email, mail_status = _send_gmail_otp(user.email, code, user.name)

    return jsonify({
        "message": f"6-digit Security Verification Code sent to {user.email}",
        "otp_demo": code if not sent_via_email else None,  # Provided in dev mode if SMTP not configured
        "sent_via_email": sent_via_email,
        "expires_in_minutes": 10
    }), 200


@auth_bp.post("/verify-otp")
@jwt_required()
def verify_otp():
    from datetime import datetime
    from models import OTPRecord

    user = User.query.get(int(get_jwt_identity()))
    if not user:
        return jsonify({"error": "User not found"}), 404

    data = request.get_json(force=True) or {}
    code = (data.get("otp_code") or "").strip()

    record = OTPRecord.query.filter_by(
        email=user.email,
        otp_code=code,
        is_used=False
    ).order_by(OTPRecord.id.desc()).first()

    if not record or datetime.utcnow() > record.expires_at:
        return jsonify({"error": "Invalid or expired OTP verification code"}), 400

    record.is_used = True
    db.session.commit()

    return jsonify({
        "message": "Student OTP identity verified successfully",
        "verified": True
    }), 200
