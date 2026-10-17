# OpenWrt package for self-hosted bufferbloat test.
# Drop this directory into a feed (or copy into package/) and:
#   make package/bufferbloat-test/compile
#
# Pre-build a static binary for your target, e.g.:
#   GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o openwrt/files/usr/bin/bufferbloat-test ./cmd/server
#   GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -o openwrt/files/usr/bin/bufferbloat-test ./cmd/server

include $(TOPDIR)/rules.mk

PKG_NAME:=bufferbloat-test
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_MAINTAINER:=OpenWrt Builder <noreply@local>
PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/bufferbloat-test
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Self-hosted bufferbloat web test
  URL:=https://github.com/openwrt-builder/custom-bufferbloat
  DEPENDS:=
endef

define Package/bufferbloat-test/description
  HTTP bufferbloat test (LibreQoS-style) for VPS and OpenWrt.
  Serves a browser UI plus /ping /download /upload endpoints.
endef

# Binary is expected at files/usr/bin/bufferbloat-test (cross-compiled outside OpenWrt build).
define Build/Compile
	true
endef

define Package/bufferbloat-test/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/bufferbloat-test $(1)/usr/bin/bufferbloat-test
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/bufferbloat-test $(1)/etc/init.d/bufferbloat-test
endef

$(eval $(call BuildPackage,bufferbloat-test))
