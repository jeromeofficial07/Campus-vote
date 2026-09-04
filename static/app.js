const { useState, useEffect, useCallback, createContext, useContext } = React;
const {
  HashRouter,
  Routes,
  Route,
  Link,
  Navigate,
  useNavigate,
  useParams,
} = ReactRouterDOM;

// ---------------------------------------------------------------------
// API helper (plain fetch, no axios needed)
// ---------------------------------------------------------------------

const API_BASE = ""; // same origin — Flask serves both API and frontend

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("token");
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Request failed");
    err.data = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------
// 12-Hour AM/PM Date & Time Helpers
// ---------------------------------------------------------------------

function combine12hDateTime(dateStr, hourStr, minStr, ampm) {
  if (!dateStr) return null;
  let hour = parseInt(hourStr, 10);
  if (isNaN(hour) || hour < 1 || hour > 12) hour = 12;
  const min = parseInt(minStr, 10) || 0;
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  const hStr = String(hour).padStart(2, "0");
  const mStr = String(min).padStart(2, "0");
  const localDate = new Date(`${dateStr}T${hStr}:${mStr}:00`);
  return isNaN(localDate.getTime()) ? null : localDate.toISOString();
}

function format12hDateTime(isoStr) {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch (e) {
    return isoStr;
  }
}

// ---------------------------------------------------------------------
// Socket.IO — single shared connection, same origin
// ---------------------------------------------------------------------

const socket = io(undefined, {
  autoConnect: true,
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

socket.on("connect", () => console.log("[socket] connected:", socket.id));
socket.on("connect_error", (err) => console.error("[socket] connection error:", err.message));
socket.on("disconnect", (reason) => console.warn("[socket] disconnected:", reason));

// ---------------------------------------------------------------------
// Auth context
// ---------------------------------------------------------------------

const AuthContext = createContext(null);

function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem("user");
    return raw ? JSON.parse(raw) : null;
  });

  // Dynamic Theme Mode: "election-light" | "election-dark"
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem("campus_vote_theme") || "election-light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("campus_vote_theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "election-dark" ? "election-light" : "election-dark"));
  }, []);

  // Blocks rendering the app until we've confirmed the server hasn't
  // restarted since the last visit (see boot-id check below).
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    fetch("/api/boot")
      .then((res) => res.json())
      .then((data) => {
        const lastBootId = localStorage.getItem("boot_id");
        if (lastBootId !== data.boot_id) {
          // Server has restarted since we last saw it — force a fresh login.
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          localStorage.setItem("boot_id", data.boot_id);
          setUser(null);
        }
      })
      .catch(() => {
        // If the check itself fails, don't block the app — just proceed
        // with whatever was already in localStorage.
      })
      .finally(() => setCheckingSession(false));
  }, []);

  // Re-fetch user profile on every page load / refresh so that admin
  // approval (is_verified) is always up-to-date even if the Socket.IO
  // event was missed (e.g. tab was closed or network hiccup).
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return;
    apiFetch("/api/auth/me")
      .then((data) => {
        if (data.user) {
          localStorage.setItem("user", JSON.stringify(data.user));
          setUser(data.user);
        }
      })
      .catch(() => {
        // Token might be expired / invalid — ignore and keep current state
      });
  }, []);

  // Listen to voter_verified_status updates via Socket.IO
  useEffect(() => {
    const handleStatusUpdate = (data) => {
      setUser((currentUser) => {
        if (currentUser && currentUser.id === data.user_id) {
          const updated = { ...currentUser, is_verified: data.is_verified };
          localStorage.setItem("user", JSON.stringify(updated));
          return updated;
        }
        return currentUser;
      });
    };

    socket.on("voter_verified_status", handleStatusUpdate);
    return () => {
      socket.off("voter_verified_status", handleStatusUpdate);
    };
  }, []);

  // Join/leave the private user room for real-time verification updates.
  // Depend on user?.id only (not the full user object) so the room is NOT
  // left and re-joined every time is_verified flips — that was causing the
  // update to be lost in a leave→rejoin race.
  const userId = user && user.id;
  useEffect(() => {
    if (userId) {
      socket.emit("join_user", { user_id: userId });
      return () => {
        socket.emit("leave_user", { user_id: userId });
      };
    }
  }, [userId]);

  const login = useCallback(async (email, password) => {
    const data = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (payload) => {
    const data = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
  }, []);

  if (checkingSession) {
    return (
      <div className="velvet-page">
        <p style={{ color: "white" }}>Loading…</p>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user, login, register, logout, theme, toggleTheme }}>
      {children}
    </AuthContext.Provider>
  );
}
function useAuth() {
  return useContext(AuthContext);
}

// ---------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------

function Navbar() {
  const { user, logout, theme, toggleTheme } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="navbar">
      <Link to="/" className="brand">
        <span className="seal">CV</span>
        Campus Vote
      </Link>
      <nav>
        <button
          type="button"
          className="theme-toggle-btn"
          onClick={toggleTheme}
          title="Toggle Modern Election Light / Midnight Navy Theme"
        >
          {theme === "election-dark" ? "☀️ Light Mode" : "🌙 Midnight Navy"}
        </button>
        {user ? (
          <>
            <Link to="/">Elections</Link>
            {user.role === "admin" && (
              <>
                <Link to="/create-poll">+ New Election</Link>
                <Link to="/admin-control">👑 Control Center</Link>
                <Link to="/admin-approvals">✅ Approvals</Link>
                <Link to="/voter-audit">🛡️ Voter Audit</Link>
              </>
            )}
            <button
              className="pill"
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              {user.name.split(" ")[0]} · Sign out
            </button>
          </>
        ) : (
          <Link to="/login" className="pill">Sign in</Link>
        )}
      </nav>
    </header>
  );
}

function ProtectedRoute({ children, adminOnly = false }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== "admin") return <Navigate to="/" replace />;
  return children;
}

function Shell({ children }) {
  return (
    <div className="app-shell">
      <Navbar />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------

function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="velvet-page">
      <div style={{ position: "absolute", top: 20, right: 24, zIndex: 20 }}>
        <button
          type="button"
          className="theme-toggle-btn"
          onClick={useAuth().toggleTheme}
          title="Toggle Modern Election Light / Midnight Navy Theme"
        >
          {useAuth().theme === "election-dark" ? "☀️ Light Mode" : "🌙 Midnight Navy"}
        </button>
      </div>
      <form className="auth-card" onSubmit={handleSubmit}>
        <span className="eyebrow">Campus Vote</span>
        <h1>Welcome back</h1>
        <p className="sub">Sign in to cast your vote or manage elections.</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label>Email</label>
          <input type="email" required placeholder="you@college.edu" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" required placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn-primary" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
        <p className="switch-line">New here? <Link to="/register">Create an account</Link></p>
      </form>
    </div>
  );
}

function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    email: "",
    roll_number: "",
    department: "Computer Science",
    year_of_study: "3rd Year",
    password: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await register(form);
      navigate("/");
    } catch (err) {
      setError(err.message || "Could not create account.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="velvet-page">
      <div style={{ position: "absolute", top: 20, right: 24, zIndex: 20 }}>
        <button
          type="button"
          className="theme-toggle-btn"
          onClick={useAuth().toggleTheme}
          title="Toggle Modern Election Light / Midnight Navy Theme"
        >
          {useAuth().theme === "election-dark" ? "☀️ Light Mode" : "🌙 Midnight Navy"}
        </button>
      </div>
      <form className="auth-card" onSubmit={handleSubmit}>
        <span className="eyebrow">Campus Vote</span>
        <h1>Register to vote</h1>
        <p className="sub">One account, one vote per election.</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label>Full name</label>
          <input required placeholder="Jane Doe" value={form.name} onChange={update("name")} />
        </div>
        <div className="field">
          <label>College email</label>
          <input type="email" required placeholder="you@college.edu" value={form.email} onChange={update("email")} />
        </div>
        <div className="field">
          <label>Roll number</label>
          <input placeholder="e.g. CS21B045" value={form.roll_number} onChange={update("roll_number")} />
        </div>
        <div className="field">
          <label>Department</label>
          <select value={form.department} onChange={update("department")} className="select-input" style={{ width: "100%", padding: "13px 16px", fontSize: 15, marginBottom: 0 }}>
            <option>Computer Science</option>
            <option>Electronics</option>
            <option>Mechanical</option>
            <option>Civil</option>
            <option>Electrical</option>
            <option>Information Technology</option>
            <option>Chemical</option>
            <option>Biotechnology</option>
          </select>
        </div>
        <div className="field">
          <label>Year of study</label>
          <select value={form.year_of_study} onChange={update("year_of_study")} className="select-input" style={{ width: "100%", padding: "13px 16px", fontSize: 15, marginBottom: 0 }}>
            <option>1st Year</option>
            <option>2nd Year</option>
            <option>3rd Year</option>
            <option>4th Year</option>
          </select>
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" required minLength={6} placeholder="••••••••" value={form.password} onChange={update("password")} />
        </div>
        <button className="btn-primary" disabled={loading}>{loading ? "Creating account…" : "Create account"}</button>
        <p className="switch-line">Already registered? <Link to="/login">Sign in</Link></p>
      </form>
    </div>
  );
}
function DashboardPage() {
  const [polls, setPolls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    apiFetch("/api/polls")
      .then(setPolls)
      .finally(() => setLoading(false));
  }, []);

  const filteredPolls = polls.filter((poll) => {
    if (filter === "active" && !poll.is_active) return false;
    if (filter === "closed" && poll.is_active) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return poll.title.toLowerCase().includes(q) || (poll.description && poll.description.toLowerCase().includes(q));
    }
    return true;
  });

  return (
    <div className="light-page">
      <div className="container">
        <div className="page-header">
          <div>
            <span className="eyebrow">✦ Campus Elections 2026</span>
            <h1>Explore Elections</h1>
          </div>
        </div>

        {/* Motion AI Banner */}
        <div className="ai-summary-bar">
          <div className="ai-badge">
            <span className="sparkle">⚡</span> Campus Vote
          </div>
          <p>Real-time live tally • 100% Verified student votes • Zero tamper guarantee</p>
        </div>

        {/* Dribbble & Apple Filter Bar */}
        <div className="filter-bar">
          <div className="segmented-tabs">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All Elections ({polls.length})</button>
            <button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>Active Open</button>
            <button className={filter === "closed" ? "active" : ""} onClick={() => setFilter("closed")}>Completed</button>
          </div>
          <div className="search-input-wrap">
            <span className="search-icon">🔍</span>
            <input placeholder="Search polls or candidates…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        {loading && <p style={{ color: "var(--text-secondary)" }}>Loading active elections…</p>}
        {!loading && filteredPolls.length === 0 && (
          <div className="empty-state">
            <div className="seal-lg">CV</div>
            <p>{search ? "No elections match your search filter." : "No elections have been opened yet. Check back once announced."}</p>
          </div>
        )}

        <div className="poll-grid">
          {filteredPolls.map((poll) => (
            <div className="poll-card" key={poll.id}>
              <div className="card-head">
                <span className={`status ${poll.is_active ? "open" : "closed"}`}>
                  <span className="dot" style={{ width: 6, height: 6, borderRadius: "50%", background: poll.is_active ? "#10b981" : "#64748b", display: "inline-block" }} />
                  {poll.is_active ? "Voting open" : "Closed"}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 }}>ID #{poll.id}</span>
              </div>
              <h3>{poll.title}</h3>
              <div className="meta" style={{ flexWrap: "wrap", gap: 8 }}>
                <span>👤 {poll.candidates.length} candidates</span>
                <span>•</span>
                <span>🗳️ {poll.total_votes} votes</span>
                {poll.end_time && (
                  <>
                    <span>•</span>
                    <span>⏰ Closes: <strong>{format12hDateTime(poll.end_time)}</strong></span>
                  </>
                )}
              </div>
              <Link to={`/polls/${poll.id}`} style={{ width: "100%" }}>
                <button className="btn-secondary">{poll.is_active ? "Cast Your Vote →" : "View Live Tally →"}</button>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CreatePollPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [academicYear, setAcademicYear] = useState("2025-2026");
  const [status, setStatus] = useState("Live");
  const [maxSelections, setMaxSelections] = useState(1);

  // 12-Hour Starting Time state (default: today 09:00 AM)
  const todayStr = new Date().toISOString().slice(0, 10);
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const [startDate, setStartDate] = useState(todayStr);
  const [startHour, setStartHour] = useState("09");
  const [startMinute, setStartMinute] = useState("00");
  const [startPeriod, setStartPeriod] = useState("AM");

  // 12-Hour Closing Time state (default: tomorrow 05:00 PM)
  const [endDate, setEndDate] = useState(tomorrowStr);
  const [endHour, setEndHour] = useState("05");
  const [endMinute, setEndMinute] = useState("00");
  const [endPeriod, setEndPeriod] = useState("PM");

  const [candidates, setCandidates] = useState([
    { name: "", position: "President", department: "Computer Science", year_of_study: "4th Year", symbol: "🦁", motto: "", campaign_promises: "", photo_url: "", bio: "", verification_status: "Verified" },
    { name: "", position: "Vice President", department: "Electronics", year_of_study: "3rd Year", symbol: "🚀", motto: "", campaign_promises: "", photo_url: "", bio: "", verification_status: "Verified" }
  ]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [aiLoadingIdx, setAiLoadingIdx] = useState(null);

  const updateCandidate = (i, field, value) => {
    const next = [...candidates];
    next[i] = { ...next[i], [field]: value };
    setCandidates(next);
  };

  const handleFileUpload = async (i, file) => {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/polls/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json();
      if (data.url) {
        updateCandidate(i, "photo_url", data.url);
      }
    } catch (err) {
      alert("Image upload failed: " + err.message);
    }
  };

  const handleAiGenerate = async (i) => {
    const cand = candidates[i];
    if (!cand.name.trim()) {
      alert("Please enter candidate name first!");
      return;
    }
    setAiLoadingIdx(i);
    try {
      const data = await apiFetch("/api/polls/ai-assist", {
        method: "POST",
        body: JSON.stringify({ name: cand.name, position: cand.position }),
      });
      const next = [...candidates];
      next[i] = {
        ...next[i],
        motto: data.motto || next[i].motto,
        campaign_promises: data.campaign_promises || next[i].campaign_promises,
        bio: data.bio || next[i].bio,
      };
      setCandidates(next);
    } catch (err) {
      alert("AI generator error: " + err.message);
    } finally {
      setAiLoadingIdx(null);
    }
  };

  const addCandidate = () => setCandidates([...candidates, { name: "", position: "Council Secretary", department: "Mechanical", year_of_study: "3rd Year", symbol: "⚡", motto: "", campaign_promises: "", photo_url: "", bio: "", verification_status: "Verified" }]);
  const removeCandidate = (i) => setCandidates(candidates.filter((_, idx) => idx !== i));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    const cleaned = candidates.filter((c) => c.name.trim());
    if (cleaned.length < 2) {
      setError("Add at least 2 candidates with names.");
      return;
    }

    const startIso = combine12hDateTime(startDate, startHour, startMinute, startPeriod);
    const endIso = combine12hDateTime(endDate, endHour, endMinute, endPeriod);

    if (startIso && endIso && new Date(endIso) <= new Date(startIso)) {
      setError("Closing time must be after the starting time.");
      return;
    }

    setLoading(true);
    try {
      const data = await apiFetch("/api/polls", {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          academic_year: academicYear,
          status,
          max_selections: Number(maxSelections),
          start_time: startIso,
          end_time: endIso,
          candidates: cleaned,
        }),
      });
      navigate(`/polls/${data.id}`);
    } catch (err) {
      setError(err.message || "Could not create the election.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="light-page">
      <div className="container" style={{ maxWidth: 880 }}>
        <div className="page-header">
          <div>
            <span className="eyebrow">👑 Election Configuration Center</span>
            <h1>Create Campus Election</h1>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          {error && <div className="error-banner" style={{ marginBottom: 20 }}>{error}</div>}
          
          {/* Section 1: General Election Setup */}
          <div className="form-section-card">
            <div className="form-section-header">
              <div>
                <h3>🏛️ General Information &amp; Rules</h3>
                <p>Define the election title, academic session, and voting criteria.</p>
              </div>
            </div>

            <div className="form-grid" style={{ marginBottom: 16 }}>
              <div className="light-field">
                <label>Election Name *</label>
                <input required placeholder="Student Council General Election 2026" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="light-field">
                <label>Academic Year / Session *</label>
                <input required placeholder="2025-2026" value={academicYear} onChange={(e) => setAcademicYear(e.target.value)} />
              </div>
            </div>

            <div className="form-grid" style={{ marginBottom: 16 }}>
              <div className="light-field">
                <label>Election Lifecycle Status</label>
                <select value={status} onChange={(e) => setStatus(e.target.value)} className="select-input">
                  <option value="Draft">Draft (Hidden from Voters)</option>
                  <option value="Scheduled">Scheduled (Upcoming)</option>
                  <option value="Live">Live (Voting Open Now)</option>
                </select>
              </div>
              <div className="light-field">
                <label>Max Candidate Selections Allowed</label>
                <select value={maxSelections} onChange={(e) => setMaxSelections(e.target.value)} className="select-input">
                  <option value={1}>1 Candidate (Single Choice Ballot)</option>
                  <option value={2}>2 Candidates (Multi-Choice)</option>
                  <option value={3}>3 Candidates (Multi-Choice)</option>
                </select>
              </div>
            </div>

            <div className="light-field">
              <label>Election Overview, Description &amp; Scope</label>
              <textarea rows={2} placeholder="Official voting rules, positions being contested, and candidate eligibility…" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>

          {/* Section 2: Voting Schedule & Timing */}
          <div className="form-section-card">
            <div className="form-section-header">
              <div>
                <h3>⏰ Election Voting Schedule (12-Hour AM/PM)</h3>
                <p>Configure the exact opening and closing schedule for student voting.</p>
              </div>
            </div>

            <div className="schedule-grid">
              {/* Starting Time Box */}
              <div className="schedule-item-box">
                <span className="schedule-label">
                  🟢 Voting Starting Time *
                </span>
                <div className="time-picker-row-assembled">
                  <input
                    type="date"
                    required
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="date-input"
                  />
                  <div className="time-pill-group">
                    <select value={startHour} onChange={(e) => setStartHour(e.target.value)} className="time-num-select">
                      {["01","02","03","04","05","06","07","08","09","10","11","12"].map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                    <span className="time-colon">:</span>
                    <select value={startMinute} onChange={(e) => setStartMinute(e.target.value)} className="time-num-select">
                      {["00","05","10","15","20","25","30","35","40","45","50","55"].map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <select value={startPeriod} onChange={(e) => setStartPeriod(e.target.value)} className="ampm-toggle-select">
                      <option value="AM">AM</option>
                      <option value="PM">PM</option>
                    </select>
                  </div>
                </div>
                <div className="schedule-badge-info">
                  <span>📅</span>
                  <span>Opens: <strong style={{ color: "var(--text-main)" }}>{format12hDateTime(combine12hDateTime(startDate, startHour, startMinute, startPeriod)) || "Select Date & Time"}</strong></span>
                </div>
              </div>

              {/* Closing Time Box */}
              <div className="schedule-item-box">
                <span className="schedule-label">
                  🔴 Voting Closing Time *
                </span>
                <div className="time-picker-row-assembled">
                  <input
                    type="date"
                    required
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="date-input"
                  />
                  <div className="time-pill-group">
                    <select value={endHour} onChange={(e) => setEndHour(e.target.value)} className="time-num-select">
                      {["01","02","03","04","05","06","07","08","09","10","11","12"].map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                    <span className="time-colon">:</span>
                    <select value={endMinute} onChange={(e) => setEndMinute(e.target.value)} className="time-num-select">
                      {["00","05","10","15","20","25","30","35","40","45","50","55"].map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <select value={endPeriod} onChange={(e) => setEndPeriod(e.target.value)} className="ampm-toggle-select">
                      <option value="AM">AM</option>
                      <option value="PM">PM</option>
                    </select>
                  </div>
                </div>
                <div className="schedule-badge-info">
                  <span>⏰</span>
                  <span>Closes: <strong style={{ color: "var(--ch-berry-rose)" }}>{format12hDateTime(combine12hDateTime(endDate, endHour, endMinute, endPeriod)) || "Select Date & Time"}</strong></span>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Candidates Configuration */}
          <div className="form-section-card">
            <div className="form-section-header">
              <div>
                <h3>👥 Candidate Profiles &amp; Manifestos</h3>
                <p>Configure candidate details, symbols, campaign promises, and photos.</p>
              </div>
              <span className="position-badge" style={{ fontSize: 12 }}>
                {candidates.length} Candidates
              </span>
            </div>

            {candidates.map((c, i) => (
              <div className="candidate-builder-card" key={i} style={{ background: "#ffffff", border: "1.5px solid var(--light-border)", borderRadius: "var(--radius-md)", padding: 20, marginBottom: 18 }}>
                <div className="card-top-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="badge-num" style={{ background: "var(--gradient-primary)", color: "#ffffff", padding: "4px 12px", borderRadius: "var(--radius-full)", fontSize: 12, fontWeight: 700 }}>
                      Candidate #{i + 1}
                    </span>
                    <span className="status open" style={{ fontSize: 11, padding: "3px 10px" }}>{c.verification_status}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="btn-ai" disabled={aiLoadingIdx === i} onClick={() => handleAiGenerate(i)}>
                      {aiLoadingIdx === i ? "Generating..." : "⚡ AI Auto-Enhance"}
                    </button>
                    {candidates.length > 2 && (
                      <button type="button" className="remove-btn" onClick={() => removeCandidate(i)} title="Remove candidate">×</button>
                    )}
                  </div>
                </div>

                <div className="form-grid" style={{ marginBottom: 14 }}>
                  <div className="light-field">
                    <label>Candidate Name *</label>
                    <input required placeholder="e.g. Sarah Jenkins" value={c.name} onChange={(e) => updateCandidate(i, "name", e.target.value)} />
                  </div>
                  <div className="light-field">
                    <label>Position / Role *</label>
                    <input placeholder="e.g. President / Vice President" value={c.position} onChange={(e) => updateCandidate(i, "position", e.target.value)} />
                  </div>
                </div>

                <div className="form-grid" style={{ marginBottom: 14 }}>
                  <div className="light-field">
                    <label>Department</label>
                    <input placeholder="e.g. Computer Science" value={c.department} onChange={(e) => updateCandidate(i, "department", e.target.value)} />
                  </div>
                  <div className="light-field">
                    <label>Year of Study &amp; Symbol</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input placeholder="e.g. 4th Year" value={c.year_of_study} onChange={(e) => updateCandidate(i, "year_of_study", e.target.value)} style={{ flex: 1 }} />
                      <select value={c.symbol} onChange={(e) => updateCandidate(i, "symbol", e.target.value)} className="select-input" style={{ width: 90 }}>
                        <option value="🦁">🦁 Lion</option>
                        <option value="🚀">🚀 Rocket</option>
                        <option value="⚡">⚡ Lightning</option>
                        <option value="🎓">🎓 Cap</option>
                        <option value="🌟">🌟 Star</option>
                        <option value="🏆">🏆 Trophy</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="light-field" style={{ marginBottom: 14 }}>
                  <label>Motto / Slogan</label>
                  <input placeholder='e.g. "Innovation, Integrity & Impact for Every Student"' value={c.motto} onChange={(e) => updateCandidate(i, "motto", e.target.value)} />
                </div>

                <div className="light-field" style={{ marginBottom: 14 }}>
                  <label>Campaign Promises / Manifesto</label>
                  <textarea rows={3} placeholder="1. 24/7 Library Access&#10;2. Subsidized Campus Transport&#10;3. Cafeteria Food Upgrades" value={c.campaign_promises} onChange={(e) => updateCandidate(i, "campaign_promises", e.target.value)} />
                </div>

                <div className="image-upload-wrap">
                  <div className="avatar-preview">
                    {c.photo_url ? <img src={c.photo_url} alt="Candidate" /> : <span>{c.symbol || "📷"}</span>}
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>Candidate Photo</label>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <div className="file-input-wrap">
                        <span className="file-input-label">📁 Choose file</span>
                        <input type="file" accept="image/*" onChange={(e) => handleFileUpload(i, e.target.files[0])} />
                      </div>
                      <input
                        className="upload-url-input"
                        placeholder="Or paste an image URL"
                        value={c.photo_url}
                        onChange={(e) => updateCandidate(i, "photo_url", e.target.value)}
                        style={{ flex: 1, minWidth: 200 }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}

            <button type="button" className="btn-add-candidate-large" onClick={addCandidate}>
              ➕ Add Another Candidate to Ballot
            </button>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 14, marginTop: 10 }}>
            <button type="button" className="btn-secondary" style={{ width: "auto", padding: "12px 28px" }} onClick={() => navigate("/")}>
              Cancel
            </button>
            <button className="btn-primary" disabled={loading} style={{ width: "auto", padding: "12px 36px" }}>
              {loading ? "Publishing Election..." : "🚀 Publish Campus Election"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AdminControlCenterPage() {
  const [polls, setPolls] = useState([]);
  const [voters, setVoters] = useState([]);
  const [voteAudit, setVoteAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("pipeline"); // pipeline | candidate_mgr | voter_mgr | vote_activity

  // CSV Import State
  const [csvText, setCsvText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");

  // Voter Roster Filters
  const [deptFilter, setDeptFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState("all");
  const [voterSearch, setVoterSearch] = useState("");

  // Vote Activity Filters
  const [auditPollFilter, setAuditPollFilter] = useState("all");
  const [auditSearch, setAuditSearch] = useState("");

  const loadData = useCallback(() => {
    Promise.all([
      apiFetch("/api/polls"),
      apiFetch("/api/polls/admin/audit/voters"),
      apiFetch("/api/polls/admin/audit/votes")
    ]).then(([pollsData, votersData, votesData]) => {
      setPolls(pollsData);
      setVoters(votersData);
      setVoteAudit(votesData);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const onUpdate = (updatedPoll) => {
      setPolls((prev) => prev.map((p) => (p.id === updatedPoll.id ? { ...p, ...updatedPoll } : p)));
      // Also silently re-fetch vote audit & voter list so real-time votes appear instantly
      Promise.all([
        apiFetch("/api/polls/admin/audit/voters"),
        apiFetch("/api/polls/admin/audit/votes")
      ]).then(([votersData, votesData]) => {
        setVoters(votersData);
        setVoteAudit(votesData);
      }).catch(() => {});
    };
    socket.on("results_update", onUpdate);
    return () => {
      socket.off("results_update", onUpdate);
    };
  }, []);

  const handleControlAction = async (pollId, action, payload = {}) => {
    try {
      await apiFetch(`/api/polls/${pollId}/control`, {
        method: "POST",
        body: JSON.stringify({ action, ...payload }),
      });
      loadData();
    } catch (err) {
      alert("Control action failed: " + err.message);
    }
  };

  const parsedCsvRows = React.useMemo(() => {
    if (!csvText.trim()) return [];
    const lines = csvText.trim().split("\n").filter(l => l.trim().length > 0);
    if (lines.length <= 1) return [];
    const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
    return lines.slice(1).map(line => {
      const cols = line.split(",").map(c => c.trim());
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = cols[idx] || "";
      });
      return {
        name: row["name"] || row["student name"] || cols[0] || "",
        email: row["email"] || cols[1] || "",
        roll_number: row["roll_number"] || row["roll_no"] || row["roll number"] || cols[2] || "",
        department: row["department"] || cols[3] || "Computer Science",
        year: row["year"] || row["year_of_study"] || cols[4] || "3rd Year",
      };
    }).filter(r => r.name || r.email);
  }, [csvText]);

  const handleInsertSampleCsv = () => {
    const sample = [
      "name,email,roll_number,department,year",
      "Alex Rivera,alex.rivera@campus.edu,CS22B014,Computer Science,3rd Year",
      "Sophia Chen,sophia.chen@campus.edu,EC21B042,Electronics,4th Year",
      "Marcus Johnson,marcus.j@campus.edu,ME23B009,Mechanical,2nd Year",
      "Elena Rostova,elena.r@campus.edu,CE22B088,Civil,3rd Year"
    ].join("\n");
    setCsvText(sample);
    setImportMsg("");
  };

  const handleDownloadSampleCsv = () => {
    const sample = "name,email,roll_number,department,year\nAlex Rivera,alex.rivera@campus.edu,CS22B014,Computer Science,3rd Year\nSophia Chen,sophia.chen@campus.edu,EC21B042,Electronics,4th Year\nMarcus Johnson,marcus.j@campus.edu,ME23B009,Mechanical,2nd Year\n";
    const blob = new Blob([sample], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "eligible_voters_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleImportCsv = async (e) => {
    e.preventDefault();
    if (!csvText.trim()) return;
    setImporting(true);
    setImportMsg("");
    try {
      const res = await apiFetch("/api/polls/admin/voters/import-csv", {
        method: "POST",
        body: JSON.stringify({ csv_text: csvText }),
      });
      setImportMsg(res.message);
      setCsvText("");
      loadData();
    } catch (err) {
      setImportMsg("Failed: " + err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleVerifyCandidate = async (pollId, candidateId, status) => {
    try {
      await apiFetch(`/api/polls/${pollId}/candidates/${candidateId}/verify`, {
        method: "PATCH",
        body: JSON.stringify({ verification_status: status }),
      });
      loadData();
    } catch (err) {
      alert("Verification update failed: " + err.message);
    }
  };

  const handleVerifyVoter = async (userId, action) => {
    try {
      const res = await apiFetch(`/api/polls/admin/voters/${userId}/verify`, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      });
      alert(res.message);
      loadData();
    } catch (err) {
      alert("Voter verification failed: " + err.message);
    }
  };

  const filteredVoters = voters.filter(v => {
    if (deptFilter !== "all" && v.department !== deptFilter) return false;
    if (yearFilter !== "all" && v.year_of_study !== yearFilter) return false;
    if (voterSearch.trim()) {
      const q = voterSearch.toLowerCase();
      return v.name.toLowerCase().includes(q) || (v.roll_number && v.roll_number.toLowerCase().includes(q)) || v.email.toLowerCase().includes(q);
    }
    return true;
  });

  const filteredAudit = voteAudit.filter(entry => {
    if (auditPollFilter !== "all" && String(entry.poll_id) !== String(auditPollFilter)) return false;
    if (auditSearch.trim()) {
      const q = auditSearch.toLowerCase();
      return (
        (entry.voter_name && entry.voter_name.toLowerCase().includes(q)) ||
        (entry.voter_roll_number && entry.voter_roll_number.toLowerCase().includes(q)) ||
        (entry.voter_email && entry.voter_email.toLowerCase().includes(q)) ||
        (entry.poll_title && entry.poll_title.toLowerCase().includes(q)) ||
        (entry.receipt_code && entry.receipt_code.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="light-page">
      <div className="container">
        <div className="page-header">
          <div>
            <span className="eyebrow">👑 Enterprise Control Center</span>
            <h1>Election Operations & Live Turnout</h1>
          </div>
          <Link to="/create-poll" className="btn-primary" style={{ padding: "10px 20px", width: "auto" }}>+ Open New Election</Link>
        </div>

        {/* Control Navigation Tabs */}
        <div className="filter-bar">
          <div className="segmented-tabs">
            <button className={tab === "pipeline" ? "active" : ""} onClick={() => setTab("pipeline")}>📊 Live Turnout Analytics</button>
            <button className={tab === "candidate_mgr" ? "active" : ""} onClick={() => setTab("candidate_mgr")}>👥 Candidates & Positions</button>
            <button className={tab === "voter_mgr" ? "active" : ""} onClick={() => setTab("voter_mgr")}>🎓 Voter Roster &amp; CSV ({voters.length}) {voters.filter(v => !v.is_verified).length > 0 && <span style={{ background: "#ef4444", color: "white", borderRadius: 10, padding: "1px 7px", fontSize: 11, marginLeft: 4 }}>{voters.filter(v => !v.is_verified).length} Pending</span>}</button>
            <button className={tab === "vote_activity" ? "active" : ""} onClick={() => setTab("vote_activity")}>🔐 Election Vote Activity &amp; Receipts ({voteAudit.length})</button>
          </div>
        </div>

        {loading ? <p>Loading Control Center...</p> : (
          <div>
            {/* Tab 1: Live Turnout Analytics & Emergency Controls */}
            {tab === "pipeline" && (
              <div className="poll-grid" style={{ gridTemplateColumns: "1fr" }}>
                {polls.map(poll => (
                  <div className="ballot" key={poll.id} style={{ padding: 28, marginBottom: 24 }}>
                    {/* Header Bar */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
                      <div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                          <span className={`status ${poll.status === "Live" ? "open" : "closed"}`}>
                            <span className="dot" style={{ background: poll.status === "Live" ? "#10b981" : "#64748b" }} />
                            Live Status: {poll.status || (poll.is_active ? "Live" : "Closed")}
                          </span>
                          <span className="position-badge">Academic Session: {poll.academic_year || "2025-2026"}</span>
                          {poll.is_locked && <span className="status closed" style={{ background: "rgba(239,68,68,0.14)", color: "#ef4444" }}>🔒 Results Locked</span>}
                        </div>
                        <h2>{poll.title}</h2>
                        <p style={{ color: "var(--text-secondary)", margin: "4px 0 12px" }}>{poll.description || "No overview provided."}</p>
                      </div>

                      {/* Emergency Control Panel */}
                      <div className="emergency-control-panel">
                        <strong style={{ fontSize: 11, textTransform: "uppercase", color: "var(--text-main)", display: "block", marginBottom: 8 }}>⚡ Emergency Controls</strong>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {poll.status === "Live" ? (
                            <button className="remove-btn" style={{ width: "auto", padding: "6px 14px", fontSize: 13 }} onClick={() => handleControlAction(poll.id, "pause")}>
                              ⏸ Emergency Pause
                            </button>
                          ) : (
                            <button className="link-btn" style={{ background: "rgba(56, 189, 248, 0.12)", padding: "6px 14px", borderRadius: 8 }} onClick={() => handleControlAction(poll.id, "resume")}>
                              ▶ Resume Live
                            </button>
                          )}
                          <button className="btn-secondary" style={{ padding: "6px 14px", width: "auto", fontSize: 13 }} onClick={() => handleControlAction(poll.id, "extend_time", { minutes: 60 })}>
                            ⏰ Extend +1 Hr
                          </button>
                          <button className="btn-secondary" style={{ padding: "6px 14px", width: "auto", fontSize: 13, borderColor: "#ef4444", color: "#ef4444" }} onClick={() => handleControlAction(poll.id, "lock_results")}>
                            🔒 Lock Results
                          </button>
                        </div>
                        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
                          <span style={{ fontSize: 12, fontWeight: 600 }}>Change Lifecycle:</span>
                          <select value={poll.status} onChange={(e) => handleControlAction(poll.id, "change_status", { status: e.target.value })} className="select-input" style={{ padding: 4, fontSize: 12 }}>
                            <option value="Draft">Draft</option>
                            <option value="Scheduled">Scheduled</option>
                            <option value="Live">Live</option>
                            <option value="Paused">Paused</option>
                            <option value="Closed">Closed</option>
                            <option value="Results">Results</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* LIVE VOTING TURNOUT PROGRESS BAR */}
                    <div style={{ marginTop: 20, padding: 20, background: "var(--light-surface)", borderRadius: 16, border: "1.5px solid var(--light-border)", boxShadow: "0 4px 16px rgba(93,49,64,0.04)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <strong style={{ fontSize: 15, color: "var(--text-main)" }}>Voting Progress (Real-Time WebSockets)</strong>
                        <span style={{ fontSize: 18, fontWeight: 800, color: "var(--ch-berry-rose)" }}>{poll.voting_percentage || 0}%</span>
                      </div>
                      
                      {/* Visual Bar */}
                      <div className="bar-track" style={{ height: 22, borderRadius: 12, background: "rgba(93,49,64,0.08)", overflow: "hidden", marginBottom: 8 }}>
                        <div className="bar-fill" style={{ width: `${poll.voting_percentage || 0}%`, height: "100%", background: "linear-gradient(135deg, #CF4173 0%, #5D3140 100%)", borderRadius: 12, transition: "width 0.6s cubic-bezier(0.16, 1, 0.3, 1)" }} />
                      </div>

                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
                        <span>🗳️ <strong>{(poll.total_votes || 0).toLocaleString()}</strong> / {(poll.total_eligible_voters || 0).toLocaleString()} students have voted</span>
                        <span>⏳ <strong>{(poll.remaining_voters || 0).toLocaleString()}</strong> remaining voters</span>
                      </div>
                    </div>

                    {/* 4 TURNOUT METRIC CARDS */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginTop: 16 }}>
                      <div className="metric-box-light" style={{ background: "rgba(75,94,166,0.06)", border: "1px solid rgba(75,94,166,0.18)", padding: 16, borderRadius: 14, boxShadow: "0 2px 10px rgba(16,20,36,0.03)" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)", letterSpacing: 0.5 }}>Total Eligible Voters</div>
                        <div style={{ fontSize: 26, fontWeight: 800, color: "var(--text-main)", marginTop: 4 }}>{(poll.total_eligible_voters || 0).toLocaleString()}</div>
                      </div>
                      <div className="metric-box-light" style={{ background: "rgba(234,70,58,0.08)", border: "1px solid rgba(234,70,58,0.22)", padding: 16, borderRadius: 14, boxShadow: "0 2px 10px rgba(234,70,58,0.04)" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--election-red)", letterSpacing: 0.5 }}>Votes Cast</div>
                        <div style={{ fontSize: 26, fontWeight: 800, color: "var(--election-red)", marginTop: 4 }}>{(poll.total_votes || 0).toLocaleString()}</div>
                      </div>
                      <div className="metric-box-light" style={{ background: "rgba(175,221,208,0.18)", border: "1px solid rgba(175,221,208,0.45)", padding: 16, borderRadius: 14, boxShadow: "0 2px 10px rgba(75,94,166,0.03)" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)", letterSpacing: 0.5 }}>Remaining Voters</div>
                        <div style={{ fontSize: 26, fontWeight: 800, color: "var(--text-main)", marginTop: 4 }}>{(poll.remaining_voters || 0).toLocaleString()}</div>
                      </div>
                      <div className="metric-box-light" style={{ background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.22)", padding: 16, borderRadius: 14, boxShadow: "0 2px 10px rgba(16,185,129,0.04)" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#10b981", letterSpacing: 0.5 }}>Voting Turnout</div>
                        <div style={{ fontSize: 26, fontWeight: 800, color: "#10b981", marginTop: 4 }}>{poll.voting_percentage || 0}%</div>
                      </div>
                    </div>

                    {/* DEPARTMENT & YEAR TURNOUT BREAKDOWNS */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 20 }}>
                      {/* Department Breakdown */}
                      <div style={{ background: "var(--light-surface)", padding: 18, borderRadius: 14, border: "1px solid var(--light-border)" }}>
                        <h4 style={{ marginBottom: 14, color: "var(--text-main)" }}>🏢 Department-wise Turnout</h4>
                        {(poll.department_turnout || []).map((d, idx) => (
                          <div key={idx} style={{ marginBottom: 10 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                              <span>{d.department}</span>
                              <span>{d.voted} / {d.total} ({d.percentage}%)</span>
                            </div>
                            <div className="bar-track" style={{ height: 10, borderRadius: 6, background: "rgba(93,49,64,0.08)", overflow: "hidden" }}>
                              <div className="bar-fill" style={{ width: `${d.percentage}%`, height: "100%", background: "var(--ch-berry-rose)", borderRadius: 6 }} />
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Year Breakdown */}
                      <div style={{ background: "var(--light-surface)", padding: 18, borderRadius: 14, border: "1px solid var(--light-border)" }}>
                        <h4 style={{ marginBottom: 14, color: "var(--text-main)" }}>🎓 Year-wise Turnout</h4>
                        {(poll.year_turnout || []).map((y, idx) => (
                          <div key={idx} style={{ marginBottom: 10 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                              <span>{y.year_of_study}</span>
                              <span>{y.voted} / {y.total} ({y.percentage}%)</span>
                            </div>
                            <div className="bar-track" style={{ height: 10, borderRadius: 6, background: "rgba(93,49,64,0.08)", overflow: "hidden" }}>
                              <div className="bar-fill" style={{ width: `${y.percentage}%`, height: "100%", background: "var(--ch-deep-plum)", borderRadius: 6 }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Tab 2: Candidate Verification & Position Management */}
            {tab === "candidate_mgr" && (
              <div>
                {polls.map(poll => (
                  <div className="ballot" key={poll.id} style={{ marginBottom: 28 }}>
                    <h3>{poll.title} — Candidates & Position Verification</h3>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16, marginTop: 16 }}>
                      {poll.candidates.map(c => (
                        <div key={c.id} className="candidate-builder-card" style={{ marginBottom: 0 }}>
                          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                            <div className="avatar-preview">
                              {c.photo_url ? <img src={c.photo_url} alt={c.name} /> : <span>{c.symbol || "⚡"}</span>}
                            </div>
                            <div style={{ flex: 1 }}>
                              <strong>{c.symbol} {c.name}</strong>
                              <div style={{ fontSize: 12, color: "var(--ch-berry-rose)", fontWeight: 700 }}>Position: {c.position || "General Candidate"}</div>
                              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{c.department || "All Depts"} · {c.year_of_study || "All Years"}</div>
                            </div>
                          </div>

                          {c.motto && <div style={{ fontSize: 12, fontStyle: "italic", margin: "8px 0 4px" }}>"{c.motto}"</div>}

                          <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>Verification Status:</span>
                            <select value={c.verification_status || "Verified"} onChange={(e) => handleVerifyCandidate(poll.id, c.id, e.target.value)} className="select-input" style={{ padding: "4px 8px", fontSize: 12 }}>
                              <option value="Verified">Verified</option>
                              <option value="Pending">Pending Review</option>
                              <option value="Rejected">Rejected</option>
                            </select>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Tab 3: Voter Roster & Bulk CSV Import */}
            {tab === "voter_mgr" && (
              <div>
                {/* Enhanced CSV Import Panel */}
                <div className="csv-import-container">
                  <div className="csv-top-bar">
                    <div>
                      <h3>📥 Bulk Student Voter Enrollment</h3>
                      <p>Import and pre-verify student voters via CSV upload or direct text paste.</p>
                    </div>
                    <div className="csv-quick-actions">
                      <button type="button" className="csv-btn-pill" onClick={handleInsertSampleCsv}>
                        📋 Insert Sample Data
                      </button>
                      <button type="button" className="csv-btn-pill" onClick={handleDownloadSampleCsv}>
                        ⬇️ Download Template (.csv)
                      </button>
                      {csvText && (
                        <button type="button" className="csv-btn-pill" onClick={() => setCsvText("")} style={{ color: "#ef4444" }}>
                          🗑️ Clear
                        </button>
                      )}
                    </div>
                  </div>

                  {importMsg && (
                    <div className={`csv-status-banner ${importMsg.toLowerCase().includes("fail") || importMsg.toLowerCase().includes("error") ? "csv-status-error" : "csv-status-success"}`}>
                      <span>{importMsg.toLowerCase().includes("fail") || importMsg.toLowerCase().includes("error") ? "⚠️" : "✅"}</span>
                      <span>{importMsg}</span>
                    </div>
                  )}

                  <form onSubmit={handleImportCsv}>
                    {/* CSV Dropzone / File Picker */}
                    <div className="csv-dropzone-box">
                      <input
                        type="file"
                        accept=".csv,text/csv,text/plain"
                        onChange={(e) => {
                          const file = e.target.files[0];
                          if (file) {
                            const reader = new FileReader();
                            reader.onload = (evt) => {
                              setCsvText(evt.target.result);
                              setImportMsg("");
                            };
                            reader.readAsText(file);
                          }
                        }}
                      />
                      <div style={{ fontSize: 28, marginBottom: 6 }}>📄</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>
                        Click to browse or drop a <code>.csv</code> voter file here
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
                        Expected Format: <code>name, email, roll_number, department, year</code>
                      </div>
                    </div>

                    {/* Monospace Code Editor Textarea */}
                    <div className="csv-editor-wrapper">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 12, fontWeight: 700, color: "var(--text-secondary)" }}>
                        <span>OR PASTE RAW CSV CONTENT:</span>
                        {parsedCsvRows.length > 0 && (
                          <span style={{ color: "var(--ch-berry-rose)", background: "rgba(207,65,115,0.08)", padding: "2px 8px", borderRadius: 4 }}>
                            ✓ {parsedCsvRows.length} Student Record(s) Detected
                          </span>
                        )}
                      </div>
                      <textarea
                        className="csv-editor-textarea"
                        rows={4}
                        placeholder={`name,email,roll_number,department,year\nJohn Doe,john@campus.edu,CS21B001,Computer Science,4th Year\nJane Smith,jane@campus.edu,EC21B005,Electronics,3rd Year`}
                        value={csvText}
                        onChange={(e) => setCsvText(e.target.value)}
                      />
                    </div>

                    {/* Live Parsed Preview Table */}
                    {parsedCsvRows.length > 0 && (
                      <div className="csv-preview-container">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                          <strong style={{ fontSize: 13, color: "var(--text-main)" }}>
                            📊 Live CSV Import Preview ({parsedCsvRows.length} students)
                          </strong>
                          <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                            Showing parsed fields ready for database enrollment
                          </span>
                        </div>
                        <table className="csv-mini-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Name</th>
                              <th>Email</th>
                              <th>Roll Number</th>
                              <th>Department</th>
                              <th>Year</th>
                            </tr>
                          </thead>
                          <tbody>
                            {parsedCsvRows.slice(0, 8).map((r, idx) => (
                              <tr key={idx}>
                                <td>{idx + 1}</td>
                                <td><strong>{r.name}</strong></td>
                                <td>{r.email}</td>
                                <td><code>{r.roll_number || "—"}</code></td>
                                <td>{r.department}</td>
                                <td>{r.year}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {parsedCsvRows.length > 8 && (
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "center", marginTop: 8 }}>
                            ... and {parsedCsvRows.length - 8} more records ready for enrollment.
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 14 }}>
                      <button
                        className="btn-primary"
                        type="submit"
                        disabled={importing || !csvText.trim()}
                        style={{ width: "auto", padding: "12px 32px" }}
                      >
                        {importing ? "Processing Enrollment..." : `🚀 Enroll ${parsedCsvRows.length ? parsedCsvRows.length + " " : ""}Voters from CSV`}
                      </button>
                      {csvText && (
                        <button
                          type="button"
                          className="btn-secondary"
                          style={{ width: "auto", padding: "12px 20px" }}
                          onClick={() => {
                            setCsvText("");
                            setImportMsg("");
                          }}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </form>
                </div>

                {/* Voter Roster & Filters */}
                <div className="filter-bar">
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="select-input">
                      <option value="all">All Departments</option>
                      <option value="Computer Science">Computer Science</option>
                      <option value="Electronics">Electronics</option>
                      <option value="Mechanical">Mechanical</option>
                      <option value="Civil">Civil</option>
                      <option value="Business">Business</option>
                    </select>

                    <select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)} className="select-input">
                      <option value="all">All Academic Years</option>
                      <option value="1st Year">1st Year</option>
                      <option value="2nd Year">2nd Year</option>
                      <option value="3rd Year">3rd Year</option>
                      <option value="4th Year">4th Year</option>
                    </select>
                  </div>

                  <div className="search-input-wrap">
                    <span className="search-icon">🔍</span>
                    <input placeholder="Filter voter name, roll no..." value={voterSearch} onChange={(e) => setVoterSearch(e.target.value)} />
                  </div>
                </div>

                <div className="ballot" style={{ padding: 24, overflowX: "auto" }}>
                  <table className="audit-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Student Name</th>
                        <th>Roll Number</th>
                        <th>Department</th>
                        <th>Year</th>
                        <th>Email</th>
                        <th>Elections Voted</th>
                        <th>Account Status</th>
                        <th>Admin Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVoters.map(s => (
                        <tr key={s.id}>
                          <td>#{s.id}</td>
                          <td><strong>{s.name}</strong></td>
                          <td><code>{s.roll_number || "N/A"}</code></td>
                          <td>{s.department || "Computer Science"}</td>
                          <td>{s.year_of_study || "3rd Year"}</td>
                          <td>{s.email}</td>
                          <td>{s.votes_count} Voted</td>
                          <td>
                            {s.is_verified ? (
                              <span className="status open" style={{ background: "rgba(16,185,129,0.1)", color: "#10b981" }}>
                                ✅ Eligible &amp; Verified
                              </span>
                            ) : (
                              <span className="status closed" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>
                                ⏳ Pending Approval
                              </span>
                            )}
                          </td>
                          <td>
                            {s.is_verified ? (
                              <button
                                className="remove-btn"
                                style={{ width: "auto", padding: "4px 12px", fontSize: 12 }}
                                onClick={() => handleVerifyVoter(s.id, "revoke")}
                              >
                                Revoke
                              </button>
                            ) : (
                              <button
                                className="btn-secondary"
                                style={{ padding: "4px 12px", width: "auto", fontSize: 12, borderColor: "#10b981", color: "#10b981" }}
                                onClick={() => handleVerifyVoter(s.id, "approve")}
                              >
                                ✓ Approve
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Tab 4: Election Vote Activity & Cryptographic Receipts */}
            {tab === "vote_activity" && (
              <div>
                <div className="ai-summary-bar" style={{ marginBottom: 20 }}>
                  <div className="ai-badge">
                    <span className="sparkle">🔐</span> Cryptographic Audit Trail
                  </div>
                  <p>
                    Every vote cast generates a unique verification receipt code stored on the ledger. 
                    Voter identity is verified while candidate selection remains 100% anonymous.
                  </p>
                </div>

                <div className="filter-bar">
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <select
                      value={auditPollFilter}
                      onChange={(e) => setAuditPollFilter(e.target.value)}
                      className="select-input"
                    >
                      <option value="all">All Elections ({voteAudit.length} total votes)</option>
                      {polls.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title} ({voteAudit.filter((v) => v.poll_id === p.id).length} votes)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="search-input-wrap">
                    <span className="search-icon">🔍</span>
                    <input
                      placeholder="Search voter name, roll no, receipt code REC-..."
                      value={auditSearch}
                      onChange={(e) => setAuditSearch(e.target.value)}
                    />
                  </div>
                </div>

                <div className="ballot" style={{ padding: 24, overflowX: "auto" }}>
                  {filteredAudit.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "30px 20px", color: "var(--text-secondary)" }}>
                      <p style={{ fontSize: 16, marginBottom: 6 }}>No vote activity records found.</p>
                      <p style={{ fontSize: 13 }}>Votes cast by students will appear here in real-time along with their cryptographic receipt codes.</p>
                    </div>
                  ) : (
                    <table className="audit-table">
                      <thead>
                        <tr>
                          <th>Vote ID</th>
                          <th>Election</th>
                          <th>Student Name</th>
                          <th>Roll Number</th>
                          <th>Email</th>
                          <th>🔐 Cryptographic Receipt Code</th>
                          <th>Ballot Type</th>
                          <th>Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredAudit.map((entry) => (
                          <tr key={entry.vote_id}>
                            <td>#{entry.vote_id}</td>
                            <td><strong>{entry.poll_title}</strong></td>
                            <td>{entry.voter_name}</td>
                            <td><code>{entry.voter_roll_number || "N/A"}</code></td>
                            <td>{entry.voter_email}</td>
                            <td>
                              <code style={{ color: "var(--ch-berry-rose)", fontWeight: 700, letterSpacing: 0.5, fontSize: 13 }}>
                                {entry.receipt_code || "N/A"}
                              </code>
                            </td>
                            <td>
                              <span className="status open" style={{ background: "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)", fontSize: 11 }}>
                                🔒 {entry.anonymous_ballot || "100% Decoupled & Anonymous"}
                              </span>
                            </td>
                            <td>{entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "N/A"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AdminAuditPage() {
  const [voters, setVoters] = useState([]);
  const [votes, setVotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("roster");
  const [search, setSearch] = useState("");

  useEffect(() => {
    Promise.all([
      apiFetch("/api/polls/admin/audit/voters"),
      apiFetch("/api/polls/admin/audit/votes")
    ])
    .then(([votersData, votesData]) => {
      setVoters(votersData);
      setVotes(votesData);
    })
    .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onVote = () => {
      Promise.all([
        apiFetch("/api/polls/admin/audit/voters"),
        apiFetch("/api/polls/admin/audit/votes")
      ]).then(([votersData, votesData]) => {
        setVoters(votersData);
        setVotes(votesData);
      }).catch(() => {});
    };
    socket.on("results_update", onVote);
    return () => {
      socket.off("results_update", onVote);
    };
  }, []);

  const filteredVoters = voters.filter(v => 
    v.name.toLowerCase().includes(search.toLowerCase()) || 
    (v.roll_number && v.roll_number.toLowerCase().includes(search.toLowerCase())) ||
    v.email.toLowerCase().includes(search.toLowerCase())
  );

  const filteredVotes = votes.filter(v => {
    const q = search.toLowerCase();
    return v.voter_name.toLowerCase().includes(q) ||
      v.voter_roll_number.toLowerCase().includes(q) ||
      v.poll_title.toLowerCase().includes(q) ||
      (v.receipt_code && v.receipt_code.toLowerCase().includes(q)) ||
      (v.voter_email && v.voter_email.toLowerCase().includes(q));
  });

  return (
    <div className="light-page">
      <div className="container">
        <div className="page-header">
          <div>
            <span className="eyebrow">🛡️ System Security & Anti-Duplicate Audit</span>
            <h1>Student Voter Integrity Dashboard</h1>
          </div>
        </div>

        <div className="ai-summary-bar">
          <div className="ai-badge">
            <span className="sparkle">🔒</span> Anti-Duplicate Enforcement
          </div>
          <p>Unique DB constraint `(poll_id, user_id)` active • 1 Student = 1 Vote per election</p>
        </div>

        <div className="filter-bar">
          <div className="segmented-tabs">
            <button className={tab === "roster" ? "active" : ""} onClick={() => setTab("roster")}>Student Roster ({voters.length})</button>
            <button className={tab === "audit_log" ? "active" : ""} onClick={() => setTab("audit_log")}>Vote Audit Logs ({votes.length})</button>
          </div>
          <div className="search-input-wrap">
            <span className="search-icon">🔍</span>
            <input placeholder="Search student name, roll no..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        {loading ? <p>Loading audit logs...</p> : (
          <div className="ballot" style={{ padding: 24, overflowX: "auto" }}>
            {tab === "roster" ? (
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Student Name</th>
                    <th>Roll Number</th>
                    <th>Email</th>
                    <th>Total Votes Cast</th>
                    <th>Integrity Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredVoters.map(s => (
                    <tr key={s.id}>
                      <td>#{s.id}</td>
                      <td><strong>{s.name}</strong></td>
                      <td><code>{s.roll_number || "N/A"}</code></td>
                      <td>{s.email}</td>
                      <td>{s.votes_count} elections voted</td>
                      <td>
                        <span className="status open" style={{ background: "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)" }}>
                          {s.integrity_flag} · Verified
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>Log ID</th>
                    <th>Election Title</th>
                    <th>Voter Student</th>
                    <th>Roll Number</th>
                    <th>Email</th>
                    <th>🔐 Receipt Code</th>
                    <th>Ballot Type</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredVotes.map(v => (
                    <tr key={v.vote_id}>
                      <td>#{v.vote_id}</td>
                      <td><strong>{v.poll_title}</strong></td>
                      <td>{v.voter_name}</td>
                      <td><code>{v.voter_roll_number}</code></td>
                      <td>{v.voter_email}</td>
                      <td><code style={{ color: "var(--ch-berry-rose)", fontWeight: 700, letterSpacing: 0.5 }}>{v.receipt_code}</code></td>
                      <td><span className="status open" style={{ background: "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)", fontSize: 11 }}>🔒 {v.anonymous_ballot}</span></td>
                      <td>{v.timestamp ? new Date(v.timestamp).toLocaleString() : "N/A"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PollDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [poll, setPoll] = useState(null);
  const [selected, setSelected] = useState(null);
  const [alreadyVoted, setAlreadyVoted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [justVoted, setJustVoted] = useState(false);
  const [receiptCode, setReceiptCode] = useState("");
  const [editingCandidate, setEditingCandidate] = useState(null);

  // OTP Verification state
  const [showOtpStep, setShowOtpStep] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);
  const [otpSentDemo, setOtpSentDemo] = useState("");
  const [otpSentEmail, setOtpSentEmail] = useState(false);
  const [otpMailStatus, setOtpMailStatus] = useState("");
  const [otpVerified, setOtpVerified] = useState(false);

  const loadPoll = useCallback(() => {
    apiFetch(`/api/polls/${id}`).then((data) => {
      setPoll(data);
      setAlreadyVoted(data.already_voted);
    });
  }, [id]);

  useEffect(() => { loadPoll(); }, [loadPoll]);

  useEffect(() => {
    const joinRoom = () => {
      socket.emit("join_poll", { poll_id: Number(id) });
    };
    joinRoom();
    socket.on("connect", joinRoom);

    const onUpdate = (updated) => {
      setPoll((prev) => (prev ? { ...prev, ...updated } : updated));
    };
    socket.on("results_update", onUpdate);

    return () => {
      socket.emit("leave_poll", { poll_id: Number(id) });
      socket.off("connect", joinRoom);
      socket.off("results_update", onUpdate);
    };
  }, [id]);

  const handleSendOtp = async () => {
    setSendingOtp(true);
    setError("");
    try {
      const res = await apiFetch("/api/auth/send-otp", { method: "POST" });
      setOtpSentDemo(res.otp_demo || "");
      setOtpSentEmail(Boolean(res.sent_via_email));
      setOtpMailStatus(res.mail_status || "");
      setShowOtpStep(true);
    } catch (err) {
      setError(err.message || "Failed to send OTP code.");
    } finally {
      setSendingOtp(false);
    }
  };

  const handleVerifyOtpAndVote = async (e) => {
    e.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setError("");
    try {
      // 1. Verify OTP
      if (!otpVerified) {
        await apiFetch("/api/auth/verify-otp", {
          method: "POST",
          body: JSON.stringify({ otp_code: otpCode }),
        });
        setOtpVerified(true);
      }

      // 2. Cast Decoupled Anonymous Vote
      const data = await apiFetch(`/api/polls/${id}/vote`, {
        method: "POST",
        body: JSON.stringify({ candidate_id: selected }),
      });

      // Find the candidate name for the success page
      const votedCandidate = poll.candidates.find(c => c.id === selected);

      // 3. Navigate to the dedicated Vote Success page
      navigate("/vote-success", {
        state: {
          pollId: Number(id),
          pollTitle: poll.title,
          receiptCode: data.receipt_code || "",
          candidateName: votedCandidate ? `${votedCandidate.symbol || "⚡"} ${votedCandidate.name}` : "",
        },
      });
    } catch (err) {
      setError(err.message || "Could not submit your vote.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleTogglePollStatus = async () => {
    try {
      const updated = await apiFetch(`/api/polls/${id}`, {
        method: "PUT",
        body: JSON.stringify({ is_active: !poll.is_active }),
      });
      setPoll(updated);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeletePoll = async () => {
    if (!confirm("Are you sure you want to delete this poll? This action cannot be undone.")) return;
    try {
      await apiFetch(`/api/polls/${id}`, { method: "DELETE" });
      navigate("/");
    } catch (err) {
      alert(err.message);
    }
  };

  const handleSaveCandidateEdit = async (e) => {
    e.preventDefault();
    try {
      await apiFetch(`/api/polls/${id}/candidates/${editingCandidate.id}`, {
        method: "PATCH",
        body: JSON.stringify(editingCandidate),
      });
      setEditingCandidate(null);
      loadPoll();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteCandidate = async (candidateId) => {
    if (!confirm("Remove this candidate?")) return;
    try {
      await apiFetch(`/api/polls/${id}/candidates/${candidateId}`, { method: "DELETE" });
      loadPoll();
    } catch (err) {
      alert(err.message);
    }
  };

  if (!poll) return <div className="light-page container">Loading poll…</div>;

  const totalVotes = poll.total_votes || 0;
  // Students must be verified by admin before they can vote
  const isUserVerified = user && (user.role === "admin" || user.is_verified === true);
  const showBallot = poll.is_active && !alreadyVoted;

  return (
    <div className="light-page">
      <div className="container" style={{ maxWidth: 840 }}>
        <div className="page-header">
          <div>
            <span className="eyebrow">{poll.is_active ? "Voting open" : "Election closed"}</span>
            <h1>{poll.title}</h1>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginTop: 8, fontSize: 13, color: "var(--text-secondary)" }}>
              {poll.start_time && (
                <span>📅 Voting Starts: <strong style={{ color: "var(--text-main)" }}>{format12hDateTime(poll.start_time)}</strong></span>
              )}
              {poll.end_time && (
                <span>⏰ Voting Closes: <strong style={{ color: "var(--ch-berry-rose)" }}>{format12hDateTime(poll.end_time)}</strong></span>
              )}
              {poll.academic_year && (
                <span>🎓 Session: <strong style={{ color: "var(--text-main)" }}>{poll.academic_year}</strong></span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="live-tag"><span className="dot" />Live</span>
            {user && user.role === "admin" && (
              <>
                <button className="link-btn" onClick={handleTogglePollStatus}>
                  {poll.is_active ? "Close Election" : "Re-open Election"}
                </button>
                <button className="remove-btn" onClick={handleDeletePoll} title="Delete Election">🗑️</button>
              </>
            )}
          </div>
        </div>

        {poll.description && (
          <p style={{ color: "var(--text-secondary)", marginTop: -8, marginBottom: 24, fontSize: 15, lineHeight: 1.6 }}>{poll.description}</p>
        )}

        {/* Pending Admin Approval Warning for Unverified Students */}
        {user && user.role !== "admin" && !isUserVerified && (
          <div className="error-banner" style={{ background: "rgba(251,191,36,0.15)", borderColor: "#f59e0b", color: "#fbbf24", marginBottom: 20 }}>
            ⚠️ <strong>Account Pending Approval</strong> — Your account has not been approved by the admin yet.
            You will be able to vote once an administrator verifies your account. Please contact your election administrator.
          </div>
        )}

        {/* Security Decoupled Anonymity Banner */}
        <div className="ai-summary-bar">
          <div className="ai-badge">
            <span className="sparkle">🔒</span> 100% Anonymous Decoupled Ballot Box
          </div>
          <p>Your identity is verified via OTP. Candidate choice is stored separately with ZERO link to your user ID.</p>
        </div>

        {receiptCode && (
          <div className="toast-confirm" style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}>
            🔐 <strong>Anonymous Vote Recorded!</strong> Your official cryptographic receipt: <code style={{ background: "rgba(255,255,255,0.2)", padding: "3px 8px", borderRadius: 4, marginLeft: 6 }}>{receiptCode}</code>
          </div>
        )}

        {justVoted && !receiptCode && <div className="toast-confirm">Your vote has been recorded securely. Live results below.</div>}
        {error && <div className="error-banner">{error}</div>}

        {/* Editing Candidate Modal */}
        {editingCandidate && (
          <form className="ballot" onSubmit={handleSaveCandidateEdit} style={{ marginBottom: 24, border: "2px solid var(--ch-berry-rose)" }}>
            <h3>Edit Candidate Profile</h3>
            <div className="light-field">
              <label>Candidate Name</label>
              <input value={editingCandidate.name} onChange={(e) => setEditingCandidate({ ...editingCandidate, name: e.target.value })} />
            </div>
            <div className="light-field">
              <label>Position</label>
              <input value={editingCandidate.position || ""} onChange={(e) => setEditingCandidate({ ...editingCandidate, position: e.target.value })} />
            </div>
            <div className="light-field">
              <label>Motto / Slogan</label>
              <input value={editingCandidate.motto || ""} onChange={(e) => setEditingCandidate({ ...editingCandidate, motto: e.target.value })} />
            </div>
            <div className="light-field">
              <label>Campaign Promises</label>
              <textarea rows={3} value={editingCandidate.campaign_promises || ""} onChange={(e) => setEditingCandidate({ ...editingCandidate, campaign_promises: e.target.value })} />
            </div>
            <div className="light-field">
              <label>Photo URL</label>
              <input value={editingCandidate.photo_url || ""} onChange={(e) => setEditingCandidate({ ...editingCandidate, photo_url: e.target.value })} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn-primary" type="submit">Save Changes</button>
              <button className="btn-secondary" type="button" onClick={() => setEditingCandidate(null)}>Cancel</button>
            </div>
          </form>
        )}

        {showBallot ? (
          <div className="ballot">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22, flexWrap: "wrap", gap: 10 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 22 }}>Official Ballot — Select Your Candidate</h3>
                <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--text-secondary)" }}>
                  Click a candidate card to select, then authenticate via OTP to cast your secure ballot.
                </p>
              </div>
              <span className="position-badge" style={{ fontSize: 12, padding: "5px 14px" }}>
                Allowed Selections: {poll.max_selections || 1}
              </span>
            </div>

            {poll.candidates.map((c) => (
              <div key={c.id} className={`candidate-row ${selected === c.id ? "selected" : ""}`} onClick={() => setSelected(c.id)}>
                <div className="avatar">
                  {c.photo_url ? <img src={c.photo_url} alt={c.name} /> : <span>{c.symbol || c.name.charAt(0)}</span>}
                </div>

                <div className="info">
                  <div className="candidate-name-row">
                    <strong>{c.symbol || "⚡"} {c.name}</strong>
                    {c.position && <span className="position-badge" style={{ fontSize: 12 }}>⚡ {c.position}</span>}
                  </div>

                  <div className="candidate-badges-row">
                    {c.department && <span className="candidate-academic-badge">🏢 {c.department}</span>}
                    {c.year_of_study && <span className="candidate-academic-badge">🎓 {c.year_of_study}</span>}
                  </div>

                  {c.motto && <p className="motto-text">"{c.motto}"</p>}

                  {c.campaign_promises && (
                    <div className="promises-box">
                      <strong style={{ display: "block", textTransform: "uppercase", color: "var(--ch-berry-rose)", marginBottom: 4, fontSize: 11.5 }}>
                        📜 Campaign Manifesto &amp; Promises:
                      </strong>
                      <p style={{ whiteSpace: "pre-line", margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>{c.campaign_promises}</p>
                    </div>
                  )}

                  {c.bio && <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "4px 0 0" }}>{c.bio}</p>}
                </div>

                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                  <div className="radio" />
                  {user && user.role === "admin" && (
                    <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                      <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setEditingCandidate(c); }}>Edit</button>
                      <button type="button" className="link-btn" style={{ fontSize: 12, color: "#ef4444" }} onClick={(e) => { e.stopPropagation(); handleDeleteCandidate(c.id); }}>Remove</button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* OTP Verification & Vote Submit Form */}
            {showOtpStep ? (
              <form onSubmit={handleVerifyOtpAndVote} style={{ marginTop: 20, padding: 20, background: "var(--light-surface)", borderRadius: 14, border: "1.5px solid rgba(234,70,58,0.35)", boxShadow: "var(--shadow-apple)" }}>
                <h4 style={{ margin: "0 0 6px", color: "var(--text-main)" }}>🔑 Enter 6-Digit Verification Code</h4>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 12px", lineHeight: 1.5 }}>
                  {otpSentEmail ? (
                    <span>✅ Security code delivered to your inbox: <strong>{user.email}</strong> (check Spam if needed).</span>
                  ) : (
                    <span>
                      Code sent to <strong>{user.email}</strong> {otpSentDemo && <span>(Demo Code: <code style={{ color: "var(--election-red)", fontWeight: 700 }}>{otpSentDemo}</code>)</span>}
                      {otpMailStatus && !otpSentEmail && <span style={{ display: "block", fontSize: 11.5, color: "#f59e0b", marginTop: 4 }}>ℹ️ Note: {otpMailStatus}</span>}
                    </span>
                  )}
                </p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <input required placeholder="Enter 6-digit OTP" value={otpCode} onChange={(e) => setOtpCode(e.target.value)} className="otp-code-input" style={{ flex: "1 1 180px" }} />
                  <button className="btn-primary" type="submit" disabled={submitting} style={{ flex: "1 1 220px" }}>
                    {submitting ? "Authenticating & Casting Ballot…" : "Verify & Cast Anonymous Ballot"}
                  </button>
                </div>
              </form>
            ) : (
              <button className="btn-primary" style={{ marginTop: 16 }} disabled={!selected || sendingOtp || !isUserVerified} onClick={handleSendOtp}>
                {!isUserVerified ? "⚠️ Account Not Yet Approved — Cannot Vote" : sendingOtp ? "Sending Security OTP…" : "Proceed to 2FA OTP & Cast Ballot"}
              </button>
            )}
          </div>
        ) : (
          <div className="ballot">
            <h3 style={{ marginBottom: 20 }}>Live Election Tally & Results</h3>
            {poll.candidates
              .slice()
              .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
              .map((c) => {
                const pct = totalVotes ? Math.round((c.vote_count / totalVotes) * 100) : 0;
                return (
                  <div className="result-row" key={c.id}>
                    <div className="result-head">
                      <div>
                        <strong>{c.symbol || "⚡"} {c.name}</strong>
                        {c.position && <span className="position-badge" style={{ marginLeft: 8 }}>⚡ {c.position}</span>}
                        {c.motto && <div style={{ fontSize: 12, color: "var(--text-secondary)", fontStyle: "italic" }}>"{c.motto}"</div>}
                      </div>
                      <span>{c.vote_count} votes · {pct}%</span>
                    </div>
                    <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
                  </div>
                );
              })}
            <p className="meta" style={{ marginTop: 14 }}>Total verified votes cast: <strong>{totalVotes}</strong></p>
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// AdminApprovalsPage — dedicated page for admin to approve/reject students
// -----------------------------------------------------------------------

function AdminApprovalsPage() {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("pending"); // pending | verified | all
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState("");

  const loadStudents = useCallback(() => {
    setLoading(true);
    apiFetch("/api/polls/admin/audit/voters")
      .then(setStudents)
      .catch(err => alert("Failed to load students: " + err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadStudents(); }, [loadStudents]);

  const handleAction = async (userId, action) => {
    setActionLoading(userId + action);
    try {
      const res = await apiFetch(`/api/polls/admin/voters/${userId}/verify`, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      });
      setToast(res.message);
      setTimeout(() => setToast(""), 3500);
      loadStudents();
    } catch (err) {
      alert("Action failed: " + err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleBulkApprove = async () => {
    const pending = students.filter(s => !s.is_verified);
    if (!pending.length) return;
    if (!confirm(`Approve all ${pending.length} pending student(s)?`)) return;
    for (const s of pending) {
      await apiFetch(`/api/polls/admin/voters/${s.id}/verify`, {
        method: "PATCH",
        body: JSON.stringify({ action: "approve" }),
      }).catch(() => {});
    }
    setToast(`${pending.length} student(s) approved successfully.`);
    setTimeout(() => setToast(""), 3500);
    loadStudents();
  };

  const filtered = students.filter(s => {
    if (filterStatus === "pending" && s.is_verified) return false;
    if (filterStatus === "verified" && !s.is_verified) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        s.name.toLowerCase().includes(q) ||
        (s.roll_number && s.roll_number.toLowerCase().includes(q)) ||
        s.email.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const pendingCount = students.filter(s => !s.is_verified).length;
  const verifiedCount = students.filter(s => s.is_verified).length;

  return (
    <div className="light-page">
      <div className="container">
        <div className="page-header">
          <div>
            <span className="eyebrow">👑 Admin — Student Verification</span>
            <h1>Account Approval Center</h1>
            <p style={{ color: "var(--text-secondary)", margin: "4px 0 0", fontSize: 15 }}>
              Review and approve student registrations before they can vote.
            </p>
          </div>
          {pendingCount > 0 && (
            <button
              className="btn-primary"
              style={{ width: "auto", padding: "10px 24px", background: "linear-gradient(135deg,#10b981,#059669)" }}
              onClick={handleBulkApprove}
            >
              ✓ Approve All Pending ({pendingCount})
            </button>
          )}
        </div>

        {toast && (
          <div className="toast-confirm" style={{ marginBottom: 20 }}>
            {toast}
          </div>
        )}

        {/* Stats Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 28 }}>
          <div style={{ background: "rgba(239,68,68,0.08)", border: "1.5px solid rgba(239,68,68,0.2)", borderRadius: 14, padding: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#ef4444" }}>⏳ Pending Approval</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: "#ef4444", marginTop: 4 }}>{pendingCount}</div>
          </div>
          <div style={{ background: "rgba(16,185,129,0.08)", border: "1.5px solid rgba(16,185,129,0.2)", borderRadius: 14, padding: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#10b981" }}>✅ Verified &amp; Eligible</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: "#10b981", marginTop: 4 }}>{verifiedCount}</div>
          </div>
          <div style={{ background: "var(--light-card)", border: "1.5px solid var(--light-border)", borderRadius: 14, padding: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)" }}>Total Students</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: "var(--text-main)", marginTop: 4 }}>{students.length}</div>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="filter-bar">
          <div className="segmented-tabs">
            <button className={filterStatus === "pending" ? "active" : ""} onClick={() => setFilterStatus("pending")}>
              ⏳ Pending ({pendingCount})
            </button>
            <button className={filterStatus === "verified" ? "active" : ""} onClick={() => setFilterStatus("verified")}>
              ✅ Verified ({verifiedCount})
            </button>
            <button className={filterStatus === "all" ? "active" : ""} onClick={() => setFilterStatus("all")}>
              All Students ({students.length})
            </button>
          </div>
          <div className="search-input-wrap">
            <span className="search-icon">🔍</span>
            <input
              placeholder="Search by name, roll no, or email…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <p style={{ color: "var(--text-secondary)", padding: 24 }}>Loading students…</p>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="seal-lg">✓</div>
            <p>{filterStatus === "pending" ? "No students pending approval. You're all caught up!" : "No students found."}</p>
          </div>
        ) : (
          <div className="ballot" style={{ padding: 24, overflowX: "auto" }}>
            <table className="audit-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Student Name</th>
                  <th>Roll Number</th>
                  <th>Department</th>
                  <th>Year</th>
                  <th>Email</th>
                  <th>Account Status</th>
                  <th>Admin Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => (
                  <tr key={s.id} style={{ background: !s.is_verified ? "rgba(239,68,68,0.03)" : undefined }}>
                    <td>#{s.id}</td>
                    <td><strong>{s.name}</strong></td>
                    <td><code>{s.roll_number || "N/A"}</code></td>
                    <td>{s.department || "Computer Science"}</td>
                    <td>{s.year_of_study || "3rd Year"}</td>
                    <td>{s.email}</td>
                    <td>
                      {s.is_verified ? (
                        <span className="status open" style={{ background: "rgba(16,185,129,0.1)", color: "#10b981" }}>
                          ✅ Verified
                        </span>
                      ) : (
                        <span className="status closed" style={{ background: "rgba(239,68,68,0.12)", color: "#ef4444" }}>
                          ⏳ Pending
                        </span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 8 }}>
                        {!s.is_verified ? (
                          <button
                            className="btn-secondary"
                            style={{ padding: "5px 14px", width: "auto", fontSize: 12, borderColor: "#10b981", color: "#10b981" }}
                            disabled={actionLoading === s.id + "approve"}
                            onClick={() => handleAction(s.id, "approve")}
                          >
                            {actionLoading === s.id + "approve" ? "..." : "✓ Approve"}
                          </button>
                        ) : (
                          <button
                            className="remove-btn"
                            style={{ width: "auto", padding: "5px 14px", fontSize: 12 }}
                            disabled={actionLoading === s.id + "revoke"}
                            onClick={() => handleAction(s.id, "revoke")}
                          >
                            {actionLoading === s.id + "revoke" ? "..." : "Revoke"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// VoteSuccessPage — full-screen celebratory confirmation after voting
// -----------------------------------------------------------------------

function VoteSuccessPage() {
  const navigate = useNavigate();
  const { state } = ReactRouterDOM.useLocation();
  const [countdown, setCountdown] = useState(12);

  const pollTitle = state?.pollTitle || "the Election";
  const receipt = state?.receiptCode || "";
  const candidateName = state?.candidateName || "";
  const pollId = state?.pollId;

  useEffect(() => {
    if (countdown <= 0) {
      navigate(pollId ? `/polls/${pollId}` : "/");
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, navigate, pollId]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--light-bg)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      textAlign: "center",
    }}>
      {/* GPay-style draw-in checkmark */}
      <div className="success-tick-wrap">
        <svg className="success-tick-svg" viewBox="0 0 80 80">
          <circle className="success-tick-circle" cx="40" cy="40" r="36" />
          <path className="success-tick-check" d="M22 41l12 12 24-24" />
        </svg>
      </div>

      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", color: "var(--ch-berry-rose)", marginBottom: 12, marginTop: 8 }}>
        Vote Recorded Successfully
      </span>

      <h1 className="vote-success-title" style={{ color: "var(--text-main)", fontWeight: 800, margin: "0 0 8px", fontFamily: "var(--font-royal)" }}>
        Your Ballot is Secured!
      </h1>

      <p style={{ color: "var(--text-secondary)", fontSize: 15, maxWidth: 480, margin: "0 auto 28px", lineHeight: 1.5 }}>
        Thank you for participating in <strong style={{ color: "var(--text-main)" }}>{pollTitle}</strong>.
        Your anonymous vote has been cryptographically recorded and cannot be altered.
      </p>

      {/* Info cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%", maxWidth: 520, marginBottom: 32 }}>
        {candidateName && (
          <div style={{ background: "var(--light-surface)", border: "1px solid var(--light-border)", borderRadius: 14, padding: "16px 20px", textAlign: "left", boxShadow: "var(--shadow-apple)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 4 }}>Candidate Voted For</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-main)" }}>{candidateName}</div>
          </div>
        )}
        {receipt && (
          <div style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 14, padding: "16px 20px", textAlign: "left" }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#059669", marginBottom: 4 }}>🔐 Cryptographic Receipt Code</div>
            <code style={{ fontSize: 15, fontWeight: 700, color: "#059669", letterSpacing: 1, wordBreak: "break-all" }}>{receipt}</code>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "6px 0 0" }}>
              Keep this receipt. It proves your vote was counted without revealing your identity.
            </p>
          </div>
        )}
        <div style={{ background: "var(--light-surface)", border: "1px solid var(--light-border)", borderRadius: 14, padding: "14px 20px", display: "flex", alignItems: "center", gap: 12, boxShadow: "var(--shadow-apple)" }}>
          <span style={{ fontSize: 22 }}>🔒</span>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, textAlign: "left" }}>
            Your vote is stored in an anonymous ballot box with <strong style={{ color: "var(--text-main)" }}>zero link</strong> to your identity. Even admins cannot see who you voted for.
          </p>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center", width: "100%", maxWidth: 440 }}>
        {pollId && (
          <button
            className="btn-primary"
            style={{ width: "100%", padding: "12px 24px", background: "linear-gradient(135deg,#10b981,#059669)" }}
            onClick={() => navigate(`/polls/${pollId}`)}
          >
            📊 View Live Tally
          </button>
        )}
        <button
          className="btn-secondary"
          style={{ width: "100%", padding: "12px 24px" }}
          onClick={() => navigate("/")}
        >
          ← Back to Elections
        </button>
      </div>

      <p style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 28 }}>
        Returning to results in {countdown}s…
      </p>

      <style>{`
        .success-tick-wrap {
          width: 120px;
          height: 120px;
          margin-bottom: 8px;
          position: relative;
        }
        .success-tick-svg {
          width: 100%;
          height: 100%;
        }
        .success-tick-circle {
          fill: none;
          stroke: #10b981;
          stroke-width: 4;
          stroke-linecap: round;
          stroke-dasharray: 226;
          stroke-dashoffset: 226;
          transform-origin: center;
          animation: tick-circle-draw 0.5s cubic-bezier(0.65, 0, 0.45, 1) forwards,
                     tick-circle-pop 0.4s ease-out 0.5s forwards;
        }
        .success-tick-check {
          fill: none;
          stroke: #10b981;
          stroke-width: 5;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-dasharray: 48;
          stroke-dashoffset: 48;
          animation: tick-check-draw 0.35s cubic-bezier(0.65, 0, 0.45, 1) 0.55s forwards;
        }
        @keyframes tick-circle-draw {
          from { stroke-dashoffset: 226; }
          to { stroke-dashoffset: 0; }
        }
        @keyframes tick-circle-pop {
          0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.35); }
          70% { box-shadow: 0 0 0 20px rgba(16,185,129,0); }
          100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
        }
        @keyframes tick-check-draw {
          from { stroke-dashoffset: 48; }
          to { stroke-dashoffset: 0; }
        }
      `}</style>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<ProtectedRoute><Shell><DashboardPage /></Shell></ProtectedRoute>} />
          <Route path="/polls/:id" element={<ProtectedRoute><Shell><PollDetailPage /></Shell></ProtectedRoute>} />
          <Route path="/vote-success" element={<ProtectedRoute><VoteSuccessPage /></ProtectedRoute>} />
          <Route path="/create-poll" element={<ProtectedRoute adminOnly><Shell><CreatePollPage /></Shell></ProtectedRoute>} />
          <Route path="/admin-control" element={<ProtectedRoute adminOnly><Shell><AdminControlCenterPage /></Shell></ProtectedRoute>} />
          <Route path="/admin-approvals" element={<ProtectedRoute adminOnly><Shell><AdminApprovalsPage /></Shell></ProtectedRoute>} />
          <Route path="/voter-audit" element={<ProtectedRoute adminOnly><Shell><AdminAuditPage /></Shell></ProtectedRoute>} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);