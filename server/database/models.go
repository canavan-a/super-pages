package database

type User struct {
	ID         string `gorm:"primaryKey"`
	SignPub    string
	BoxPub     string
	Email      string
	Name       string
	AvatarBlob *string
	KeyBundle  string
	KeyGen     int64
	CreatedAt  int64 `gorm:"autoCreateTime:false"`
}

type Document struct {
	ID         string `gorm:"primaryKey"`
	CreatedBy  string
	Version    int64
	KeyEpoch   int64
	HeadCt     string
	BodyCt     string
	Sig        string
	UpdatedBy  string
	UpdatedAt  int64 `gorm:"autoUpdateTime:false"`
	CreatedAt  int64 `gorm:"autoCreateTime:false"`
	NeedsRekey bool
}

type DocMember struct {
	DocID   string `gorm:"primaryKey"`
	UserID  string `gorm:"primaryKey"`
	Role    string
	AddedBy string
	AddedAt int64
}

type DocKey struct {
	DocID      string `gorm:"primaryKey"`
	UserID     string `gorm:"primaryKey"`
	Epoch      int64
	WrappedKey string
}

type PendingShare struct {
	ID        string `gorm:"primaryKey"`
	DocID     string
	Email     string
	Role      string
	InvitedBy string
	CreatedAt int64 `gorm:"autoCreateTime:false"`
}

type ShareLink struct {
	ID        string `gorm:"primaryKey"`
	DocID     string
	Role      string
	LinkPub   string
	KeyCt     string
	Epoch     int64
	CreatedBy string
	ExpiresAt *int64
	MaxUses   *int64
	Uses      int64
	Revoked   bool
	CreatedAt int64 `gorm:"autoCreateTime:false"`
}

type Blob struct {
	ID        string `gorm:"primaryKey"`
	DocID     *string
	Uploader  string
	Size      int64
	CreatedAt int64 `gorm:"autoCreateTime:false"`
}

// Roles, strongest first.
const (
	RoleOwner = "owner"
	RoleEdit  = "edit"
	RoleView  = "view"
)

// ValidRole reports whether r is one of the three roles.
func ValidRole(r string) bool { return r == RoleOwner || r == RoleEdit || r == RoleView }

// CanWrite reports whether role may change a document's content.
func CanWrite(role string) bool { return role == RoleOwner || role == RoleEdit }
