package duckdb

import (
	"context"
	"database/sql/driver"
	"strings"
)

type ErrorType int

const (
	ErrorTypeDependency ErrorType = iota
	ErrorTypeConstraint
	ErrorTypeCatalog
	ErrorTypeParser
	ErrorTypeSyntax
	ErrorTypeBinder
	ErrorTypeConversion
	ErrorTypeInvalidInput
	ErrorTypeOutOfRange
	ErrorTypeMismatchType
	ErrorTypeTransaction
	ErrorTypeNotImplemented
	ErrorTypeMissingExtension
	ErrorTypeAutoLoad
	ErrorTypeIO
	ErrorTypePermission
)

type Error struct {
	Type    ErrorType
	Message string
}

func (e *Error) Error() string { return e.Message }

type Connector struct{ dsn string }

func NewConnector(dsn string, _ any) (*Connector, error) { return &Connector{dsn: dsn}, nil }
func (c *Connector) Connect(ctx context.Context) (driver.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return Driver{}.Open(c.dsn)
}
func (c *Connector) Driver() driver.Driver              { return c }
func (c *Connector) Open(_ string) (driver.Conn, error) { return c.Connect(context.Background()) }

func classifyError(message string) error {
	kind := ErrorTypeInvalidInput
	lower := strings.ToLower(message)
	for _, match := range []struct {
		prefix string
		kind   ErrorType
	}{
		{"dependency error", ErrorTypeDependency},
		{"constraint error", ErrorTypeConstraint},
		{"catalog error", ErrorTypeCatalog},
		{"parser error", ErrorTypeParser},
		{"syntax error", ErrorTypeSyntax},
		{"binder error", ErrorTypeBinder},
		{"conversion error", ErrorTypeConversion},
		{"transaction error", ErrorTypeTransaction},
		{"not implemented error", ErrorTypeNotImplemented},
		{"io error", ErrorTypeIO},
	} {
		if strings.Contains(lower, match.prefix) {
			kind = match.kind
			break
		}
	}
	return &Error{Type: kind, Message: message}
}
